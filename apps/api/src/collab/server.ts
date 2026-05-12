import { Hocuspocus } from '@hocuspocus/server';
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
  applyDocumentState(roomName: string, yjsState: Uint8Array): Promise<void>;
  closeDocumentConnections(roomName: string): void;
}

export interface CollabRoomStore {
  canHandleRoom(roomName: string): boolean;
  loadRoomState(roomName: string): Promise<LoadedDocumentState | null>;
  storeRoomState(
    roomName: string,
    yjsState: Uint8Array,
    expectedStateFingerprint: string | null,
  ): Promise<{
    stored: boolean;
    stateFingerprint?: string;
    yjsState?: Uint8Array;
    prepare?: () => Promise<void>;
    markApplied?: () => Promise<void>;
    commit?: () => Promise<boolean | void>;
    abort?: () => Promise<void>;
  }>;
}

export interface CreateCollabServerOptions {
  localStore?: CollabRoomStore;
  localDaemonToken?: string;
  localOnly?: boolean;
}

export function createCollabServer(pool: DbPool, options: CreateCollabServerOptions = {}) {
  const requireAuth = process.env.MARKLAB_REQUIRE_AUTH === 'true';
  const devAnonymousAccess = process.env.MARKLAB_ENABLE_DEV_ANONYMOUS_COLLAB === 'true';
  const loadedStateByDocument = new WeakMap<Y.Doc, LoadedDocumentState>();
  const activeDocumentByRoomName = new Map<string, Y.Doc>();
  const applyingLocalStoreUpdate = new WeakSet<Y.Doc>();
  const localStore = options.localStore;
  const localOnly = options.localOnly ?? Boolean(localStore);
  const localStoreUpdateOrigin = Symbol('marklab.local-store-update');

  function localStoreForRoom(documentName: string): CollabRoomStore | null {
    return localStore?.canHandleRoom(documentName) ? localStore : null;
  }

  function assertLocalRoomAllowed(documentName: string): void {
    if (localOnly && !localStoreForRoom(documentName)) throw new Error('forbidden');
  }

  function assertLocalToken(token: string | undefined): void {
    if (!options.localDaemonToken || token !== options.localDaemonToken) throw new Error('forbidden');
  }

  async function refreshDocumentState(documentName: string, document: Y.Doc): Promise<LoadedDocumentState | null> {
    const local = localStoreForRoom(documentName);
    if (local) {
      const loaded = await local.loadRoomState(documentName);
      if (loaded?.yjsState) Y.applyUpdate(document, loaded.yjsState);
      return loaded;
    }

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
    const updateFingerprint = encodeYjsStateFingerprint(update);
    const loaded = loadedStateByDocument.get(document);
    const local = localStoreForRoom(documentName);
    if (local) {
      if (applyingLocalStoreUpdate.has(document)) return;
      const providerDocumentChanged = () => encodeYjsStateFingerprint(Y.encodeStateAsUpdate(document)) !== updateFingerprint;
      const stored = await local.storeRoomState(documentName, update, loaded?.stateFingerprint ?? null);
      if (!stored.stored) {
        handleStoreFailure(document, loaded ?? null, options);
        return;
      }

      if (stored.stateFingerprint !== undefined) {
        const storedUpdate = stored.yjsState ?? update;
        if (providerDocumentChanged()) {
          await stored.abort?.();
          handleStoreFailure(document, loaded ?? null, options);
          return;
        }
        if (stored.yjsState) {
          const validationDocument = new Y.Doc();
          try {
            Y.applyUpdate(validationDocument, stored.yjsState);
          } finally {
            validationDocument.destroy();
          }
        }
        await stored.prepare?.();
        if (providerDocumentChanged()) {
          await stored.abort?.();
          handleStoreFailure(document, loaded ?? null, options);
          return;
        }
        if (stored.yjsState) {
          applyingLocalStoreUpdate.add(document);
          try {
            Y.applyUpdate(document, stored.yjsState, localStoreUpdateOrigin);
          } catch (error) {
            await stored.abort?.();
            throw error;
          } finally {
            applyingLocalStoreUpdate.delete(document);
          }
        }
        const postApplyUpdate = Y.encodeStateAsUpdate(document);
        const postApplyFingerprint = encodeYjsStateFingerprint(postApplyUpdate);
        await stored.markApplied?.();
        if (encodeYjsStateFingerprint(Y.encodeStateAsUpdate(document)) !== postApplyFingerprint) {
          await stored.abort?.();
          handleStoreFailure(document, loaded ?? null, options);
          return;
        }
        const committed = await stored.commit?.();
        if (committed === false) {
          handleStoreFailure(document, loaded ?? null, options);
          return;
        }
        loadedStateByDocument.set(document, {
          stateFingerprint: stored.stateFingerprint,
          yjsState: stored.yjsState ? postApplyUpdate : storedUpdate,
        });
        return;
      }

      handleStoreFailure(document, loaded ?? null, options);
      return;
    }

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
      if (localStoreForRoom(documentName)) {
        assertLocalToken(token);
        return;
      }
      assertLocalRoomAllowed(documentName);
      if (!requireAuth && devAnonymousAccess) return;
      parseRoomName(documentName);
      throw new Error('forbidden');
    },
    async onLoadDocument({ documentName, document }: { documentName: string; document: Y.Doc }) {
      const local = localStoreForRoom(documentName);
      if (local) {
        const loaded = await local.loadRoomState(documentName);
        if (loaded) {
          loadedStateByDocument.set(document, {
            stateFingerprint: loaded.stateFingerprint,
            yjsState: loaded.yjsState,
          });
        }
        activeDocumentByRoomName.set(documentName, document);
        return loaded?.yjsState ?? createEmptyYjsState();
      }
      assertLocalRoomAllowed(documentName);

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
      assertLocalRoomAllowed(documentName);
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
