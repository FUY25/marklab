import { Hocuspocus } from '@hocuspocus/server';
import * as Y from 'yjs';
import type { DbPool } from '../db/client';
import { isAdminToken, verifyDocumentAccess } from '../services/access-control';
import { encodeYjsStateFingerprint } from '../services/yjs-state-fingerprint';
import { createEmptyYjsState, loadYjsStateWithMetadata, parseRoomName, storeYjsState } from './persistence';

interface LoadedDocumentState {
  stateFingerprint: string;
  yjsState: Uint8Array | null;
}

interface StoreDocumentStateOptions {
  failOnPersistFailure?: boolean;
}

export interface CollabServerHandle {
  server: Hocuspocus;
  flushDocument(roomName: string): Promise<void>;
  applyDocumentState(roomName: string, yjsState: Uint8Array): Promise<void>;
  closeDocumentConnections(roomName: string): void;
}

export function createCollabServer(pool: DbPool) {
  const requireAuth = process.env.MARKLAB_REQUIRE_AUTH === 'true';
  const loadedStateByDocument = new WeakMap<Y.Doc, LoadedDocumentState>();
  const activeDocumentByRoomName = new Map<string, Y.Doc>();

  async function refreshDocumentState(documentName: string, document: Y.Doc): Promise<LoadedDocumentState | null> {
    const loaded = await loadYjsStateWithMetadata(pool, documentName);
    if (loaded.stateFingerprint === null) return null;
    if (loaded.yjsState) Y.applyUpdate(document, loaded.yjsState);
    return {
      stateFingerprint: loaded.stateFingerprint,
      yjsState: loaded.yjsState,
    };
  }

  function handleStoreFailure(document: Y.Doc, refreshed: LoadedDocumentState | null, options: StoreDocumentStateOptions): void {
    if (refreshed) {
      loadedStateByDocument.set(document, refreshed);
    } else {
      loadedStateByDocument.delete(document);
    }

    if (options.failOnPersistFailure) {
      throw new Error('active_collab_flush_failed');
    }
  }

  async function storeDocumentState(
    documentName: string,
    document: Y.Doc,
    options: StoreDocumentStateOptions = {},
  ): Promise<void> {
    const update = Y.encodeStateAsUpdate(document);
    const loaded = loadedStateByDocument.get(document);
    const stored = await storeYjsState(pool, documentName, update, loaded?.stateFingerprint ?? null, loaded?.yjsState ?? null);
    if (stored.stored && stored.stateFingerprint !== undefined) {
      loadedStateByDocument.set(document, {
        stateFingerprint: stored.stateFingerprint,
        yjsState: update,
      });
      return;
    }

    const refreshed = await refreshDocumentState(documentName, document);
    if (!refreshed) {
      handleStoreFailure(document, null, options);
      return;
    }

    const mergedUpdate = Y.encodeStateAsUpdate(document);
    const retry = await storeYjsState(pool, documentName, mergedUpdate, refreshed.stateFingerprint, refreshed.yjsState);
    if (retry.stored && retry.stateFingerprint !== undefined) {
      loadedStateByDocument.set(document, {
        stateFingerprint: retry.stateFingerprint,
        yjsState: mergedUpdate,
      });
    } else {
      handleStoreFailure(document, refreshed, options);
    }
  }

  const server = new Hocuspocus({
    name: 'marklab',
    async onAuthenticate({ documentName, token }: { documentName: string; token: string }) {
      if (!requireAuth) return;
      try {
        if (isAdminToken(token, process.env.MARKLAB_ADMIN_TOKEN_HASH)) return;
        const { docId, branchId } = parseRoomName(documentName);
        await verifyDocumentAccess(pool, token, docId, branchId, 'write');
      } catch {
        throw new Error('forbidden');
      }
    },
    async onLoadDocument({ documentName, document }: { documentName: string; document: Y.Doc }) {
      const loaded = await loadYjsStateWithMetadata(pool, documentName);
      if (loaded.stateFingerprint !== null) {
        loadedStateByDocument.set(document, {
          stateFingerprint: loaded.stateFingerprint,
          yjsState: loaded.yjsState,
        });
      }
      activeDocumentByRoomName.set(documentName, document);
      return loaded.yjsState ?? createEmptyYjsState();
    },
    async onStoreDocument({ documentName, document }: { documentName: string; document: Y.Doc }) {
      activeDocumentByRoomName.set(documentName, document);
      await storeDocumentState(documentName, document);
    },
    async afterUnloadDocument({ documentName }: { documentName: string }) {
      const document = activeDocumentByRoomName.get(documentName);
      if (document) loadedStateByDocument.delete(document);
      activeDocumentByRoomName.delete(documentName);
    },
  });

  return {
    server,
    async flushDocument(roomName: string) {
      const document = activeDocumentByRoomName.get(roomName);
      if (!document) return;
      await storeDocumentState(roomName, document, { failOnPersistFailure: true });
    },
    async applyDocumentState(roomName: string, yjsState: Uint8Array) {
      const document = activeDocumentByRoomName.get(roomName);
      if (!document) return;

      const nextState = new Uint8Array(yjsState);
      const validationDocument = new Y.Doc();
      try {
        Y.applyUpdate(validationDocument, nextState);
      } finally {
        validationDocument.destroy();
      }

      loadedStateByDocument.set(document, {
        stateFingerprint: encodeYjsStateFingerprint(nextState),
        yjsState: nextState,
      });
      Y.applyUpdate(document, nextState);
    },
    closeDocumentConnections(roomName: string) {
      server.closeConnections(roomName);
    },
  } satisfies CollabServerHandle;
}
