import { Hocuspocus } from '@hocuspocus/server';
import { sha256Hex } from '@marklab/shared/src/hash';
import * as Y from 'yjs';
import type { DbPool } from '../db/client';
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
  applyDocumentState(
    roomName: string,
    yjsState: Uint8Array,
    options?: { expectedCurrentHash?: string },
  ): Promise<Uint8Array | void>;
  verifyDocumentState(roomName: string, options?: { expectedCurrentHash?: string }): Promise<void>;
  closeDocumentConnections(roomName: string): void;
}

export function createCollabServer(pool: DbPool) {
  const requireAuth = process.env.MARKLAB_REQUIRE_AUTH === 'true';
  const devAnonymousAccess = process.env.MARKLAB_ENABLE_DEV_ANONYMOUS_COLLAB === 'true';
  const loadedStateByDocument = new WeakMap<Y.Doc, LoadedDocumentState>();
  const activeDocumentByRoomName = new Map<string, Y.Doc>();
  const documentApplyOrigin = Symbol('marklab.document-apply');

  function activeMarkdownFromDocument(document: Y.Doc): string {
    const contents = document.getText('contents').toString();
    const legacyContents = document.getText('prosemirror').toString();
    if (!contents && legacyContents) return legacyContents;
    return contents;
  }

  function assertActiveDocumentHash(document: Y.Doc, expectedCurrentHash: string | undefined): void {
    if (expectedCurrentHash && sha256Hex(activeMarkdownFromDocument(document)) !== expectedCurrentHash) {
      throw new Error('stale_conflict_shared_state');
    }
  }

  function replaceYTextWithChangedRange(text: Y.Text, nextText: string): void {
    const currentText = text.toString();
    if (currentText === nextText) return;

    let start = 0;
    while (
      start < currentText.length
      && start < nextText.length
      && currentText.charCodeAt(start) === nextText.charCodeAt(start)
    ) {
      start += 1;
    }

    let currentEnd = currentText.length;
    let nextEnd = nextText.length;
    while (
      currentEnd > start
      && nextEnd > start
      && currentText.charCodeAt(currentEnd - 1) === nextText.charCodeAt(nextEnd - 1)
    ) {
      currentEnd -= 1;
      nextEnd -= 1;
    }

    if (currentEnd > start) text.delete(start, currentEnd - start);
    const inserted = nextText.slice(start, nextEnd);
    if (inserted) text.insert(start, inserted);
  }

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
    async onAuthenticate({ documentName }: { documentName: string; token: string }) {
      if (!requireAuth && devAnonymousAccess) return;
      parseRoomName(documentName);
      throw new Error('forbidden');
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
    async applyDocumentState(
      roomName: string,
      yjsState: Uint8Array,
      options?: { expectedCurrentHash?: string },
    ) {
      const document = activeDocumentByRoomName.get(roomName);
      if (!document) return;

      const nextState = new Uint8Array(yjsState);
      const validationDocument = new Y.Doc();
      let nextTextName: 'contents' | 'prosemirror' = 'contents';
      let nextText = '';
      try {
        Y.applyUpdate(validationDocument, nextState);
        const nextContents = validationDocument.getText('contents').toString();
        const nextProsemirror = validationDocument.getText('prosemirror').toString();
        const activeContents = document.getText('contents');
        const activeProsemirror = document.getText('prosemirror');
        if (!nextContents && (nextProsemirror || (activeProsemirror.length > 0 && activeContents.length === 0))) {
          nextTextName = 'prosemirror';
          nextText = nextProsemirror;
        } else {
          nextText = nextContents;
        }
      } finally {
        validationDocument.destroy();
      }

      const contents = document.getText(nextTextName);
      const legacyContents = document.getText(nextTextName === 'contents' ? 'prosemirror' : 'contents');
      assertActiveDocumentHash(document, options?.expectedCurrentHash);
      document.transact(() => {
        replaceYTextWithChangedRange(contents, nextText);
        if (legacyContents.length > 0) legacyContents.delete(0, legacyContents.length);
      }, documentApplyOrigin);
      const appliedState = Y.encodeStateAsUpdate(document);
      loadedStateByDocument.set(document, {
        stateFingerprint: encodeYjsStateFingerprint(nextState),
        yjsState: nextState,
      });
      return appliedState;
    },
    async verifyDocumentState(roomName: string, options?: { expectedCurrentHash?: string }) {
      const document = activeDocumentByRoomName.get(roomName);
      if (!document) return;
      assertActiveDocumentHash(document, options?.expectedCurrentHash);
    },
    closeDocumentConnections(roomName: string) {
      server.closeConnections(roomName);
    },
  } satisfies CollabServerHandle;
}
