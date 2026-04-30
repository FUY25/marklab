import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { DbPool, DbQueryResult, DbTransactionClient } from '../db/client';
import { encodeYjsStateFingerprint } from '../services/yjs-state-fingerprint';
import { toRoomName } from './persistence';
import { createCollabServer } from './server';

interface TestableHocuspocus {
  configuration: {
    onLoadDocument(payload: { documentName: string; document: Y.Doc }): Promise<Uint8Array | null>;
    onStoreDocument(payload: { documentName: string; document: Y.Doc }): Promise<void>;
  };
  destroy?(): Promise<void> | void;
}

function createState(text: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getText('prosemirror').insert(0, text);
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

function updateState(baseState: Uint8Array, mutate: (text: Y.Text) => void): Uint8Array {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, baseState);
  mutate(doc.getText('prosemirror'));
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

function textFromState(state: Uint8Array): string {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  const text = doc.getText('prosemirror').toString();
  doc.destroy();
  return text;
}

function createPersistencePool(initialState: Uint8Array) {
  let persistedState = initialState;
  let stateFingerprint = encodeYjsStateFingerprint(initialState);
  let storeAttemptCount = 0;

  const query: DbPool['query'] = async <Row = unknown>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<DbQueryResult<Row>> => {
    if (sql.includes('select yjs_state, yjs_state_fingerprint')) {
      return {
        rows: [{ yjs_state: Buffer.from(persistedState), yjs_state_fingerprint: stateFingerprint } as Row],
        rowCount: 1,
      };
    }

    if (sql.includes('update document_branch_states')) {
      storeAttemptCount += 1;
      const expectedFingerprint = params?.[2];
      const nextFingerprint = params?.[3];
      const expectedState = params?.[4];
      const expectedStateMatches =
        expectedState instanceof Buffer && Buffer.compare(Buffer.from(persistedState), expectedState) === 0;
      if (stateFingerprint !== expectedFingerprint && !expectedStateMatches) {
        return { rows: [], rowCount: 0 } as DbQueryResult<Row>;
      }

      persistedState = new Uint8Array(params?.[1] as Buffer);
      stateFingerprint = String(nextFingerprint);
      return {
        rows: [{ yjs_state_fingerprint: stateFingerprint } as Row],
        rowCount: 1,
      };
    }

    return { rows: [], rowCount: 0 } as DbQueryResult<Row>;
  };

  const client: DbTransactionClient = {
    query,
    release: () => undefined,
  };

  const pool: DbPool = {
    query,
    connect: async () => client,
  };

  return {
    pool,
    getPersistedState: () => persistedState,
    getStoreAttemptCount: () => storeAttemptCount,
    replacePersistedState(nextState: Uint8Array) {
      persistedState = nextState;
      stateFingerprint = encodeYjsStateFingerprint(nextState);
    },
  };
}

describe('createCollabServer persistence hooks', () => {
  it('recovers after an API write wins the Yjs persistence race for an open document', async () => {
    const initialState = createState('loaded');
    const apiState = updateState(initialState, (text) => text.insert(text.length, ' api'));
    const store = createPersistencePool(initialState);
    const server = createCollabServer(store.pool) as unknown as TestableHocuspocus;
    const document = new Y.Doc();
    const roomName = toRoomName('doc_001', 'br_main');

    try {
      const loadedState = await server.configuration.onLoadDocument({ documentName: roomName, document });
      expect(loadedState).toBeInstanceOf(Uint8Array);
      Y.applyUpdate(document, loadedState ?? new Uint8Array());
      document.getText('prosemirror').insert(document.getText('prosemirror').length, ' human');

      store.replacePersistedState(apiState);

      await server.configuration.onStoreDocument({ documentName: roomName, document });

      expect(store.getStoreAttemptCount()).toBe(2);
      expect(textFromState(store.getPersistedState())).toContain('api');
      expect(textFromState(store.getPersistedState())).toContain('human');

      document.getText('prosemirror').insert(document.getText('prosemirror').length, ' again');
      await server.configuration.onStoreDocument({ documentName: roomName, document });

      expect(textFromState(store.getPersistedState())).toContain('again');
    } finally {
      document.destroy();
      await server.destroy?.();
    }
  });
});
