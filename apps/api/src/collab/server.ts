import { Hocuspocus } from '@hocuspocus/server';
import * as Y from 'yjs';
import type { DbPool } from '../db/client';
import { createEmptyYjsState, loadYjsStateWithMetadata, storeYjsState } from './persistence';

interface LoadedDocumentState {
  stateFingerprint: string;
  yjsState: Uint8Array | null;
}

export function createCollabServer(pool: DbPool) {
  const loadedStateByDocument = new WeakMap<Y.Doc, LoadedDocumentState>();

  async function refreshDocumentState(documentName: string, document: Y.Doc): Promise<LoadedDocumentState | null> {
    const loaded = await loadYjsStateWithMetadata(pool, documentName);
    if (loaded.stateFingerprint === null) return null;
    if (loaded.yjsState) Y.applyUpdate(document, loaded.yjsState);
    return {
      stateFingerprint: loaded.stateFingerprint,
      yjsState: loaded.yjsState,
    };
  }

  return new Hocuspocus({
    name: 'marklab',
    async onLoadDocument({ documentName, document }: { documentName: string; document: Y.Doc }) {
      const loaded = await loadYjsStateWithMetadata(pool, documentName);
      if (loaded.stateFingerprint !== null) {
        loadedStateByDocument.set(document, {
          stateFingerprint: loaded.stateFingerprint,
          yjsState: loaded.yjsState,
        });
      }
      return loaded.yjsState ?? createEmptyYjsState();
    },
    async onStoreDocument({ documentName, document }: { documentName: string; document: Y.Doc }) {
      const update = Y.encodeStateAsUpdate(document);
      const loaded = loadedStateByDocument.get(document);
      const stored = await storeYjsState(pool, documentName, update, loaded?.stateFingerprint ?? null, loaded?.yjsState ?? null);
      if (stored.stored && stored.stateFingerprint !== undefined) {
        loadedStateByDocument.set(document, {
          stateFingerprint: stored.stateFingerprint,
          yjsState: update,
        });
      } else {
        const refreshed = await refreshDocumentState(documentName, document);
        if (!refreshed) {
          loadedStateByDocument.delete(document);
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
          loadedStateByDocument.set(document, refreshed);
        }
      }
    },
  });
}
