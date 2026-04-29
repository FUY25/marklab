import { Hocuspocus } from '@hocuspocus/server';
import * as Y from 'yjs';
import type { DbPool } from '../db/client';
import { createEmptyYjsState, loadYjsState, storeYjsState } from './persistence';

export function createCollabServer(pool: DbPool) {
  return new Hocuspocus({
    name: 'marklab',
    async onLoadDocument({ documentName }: { documentName: string }) {
      return (await loadYjsState(pool, documentName)) ?? createEmptyYjsState();
    },
    async onStoreDocument({ documentName, document }: { documentName: string; document: Y.Doc }) {
      const update = Y.encodeStateAsUpdate(document);
      await storeYjsState(pool, documentName, update);
    },
  });
}
