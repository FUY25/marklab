import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { DbExecutor, DbQueryResult } from '../db/client';
import {
  createEmptyYjsState,
  loadYjsState,
  loadYjsStateWithMetadata,
  parseRoomName,
  storeYjsState,
  toRoomName,
} from './persistence';
import { encodeYjsStateFingerprint } from '../services/yjs-state-fingerprint';

function createValidYjsState(text: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getText('prosemirror').insert(0, text);
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

describe('parseRoomName', () => {
  it('parses doc branch room', () => {
    expect(parseRoomName('doc:doc_abc:branch:br_main')).toEqual({ docId: 'doc_abc', branchId: 'br_main' });
  });

  it('rejects invalid room', () => {
    expect(() => parseRoomName('bad')).toThrow('invalid_room_name');
  });
});

describe('toRoomName', () => {
  it('builds the branch-aware room name', () => {
    expect(toRoomName('doc_abc', 'br_main')).toBe('doc:doc_abc:branch:br_main');
  });
});

describe('createEmptyYjsState', () => {
  it('returns a non-empty valid encoded update', () => {
    expect(createEmptyYjsState().byteLength).toBeGreaterThan(0);
  });
});

describe('loadYjsState', () => {
  it('treats legacy zero-length state as missing', async () => {
    const pool = {
      query: async () => ({ rows: [{ yjs_state: Buffer.alloc(0) }] }),
    };

    expect(await loadYjsState(pool as DbExecutor, 'doc:doc_abc:branch:br_main')).toBeNull();
  });
});

describe('storeYjsState', () => {
  it('stores the first Hocuspocus update for migrated rows with a null persisted fingerprint', async () => {
    const loadedState = createValidYjsState('loaded before migration');
    const nextState = createValidYjsState('first live edit after migration');
    let persistedState = loadedState;
    let stateFingerprint: string | null = null;
    const fallbackLoadedFingerprint = encodeYjsStateFingerprint(loadedState);
    const expectedNextFingerprint = encodeYjsStateFingerprint(nextState);

    const pool: DbExecutor = {
      query: async <Row = unknown>(sql: string, params?: readonly unknown[]): Promise<DbQueryResult<Row>> => {
        if (sql.includes('select yjs_state')) {
          return {
            rows: [{ yjs_state: Buffer.from(persistedState), yjs_state_fingerprint: stateFingerprint }],
            rowCount: 1,
          } as DbQueryResult<Row>;
        }

        if (sql.includes('update document_branch_states')) {
          const expectedLoadedState = params?.[4] as Buffer | undefined;
          const isFreshMigratedRow =
            stateFingerprint === null &&
            params?.[2] === fallbackLoadedFingerprint &&
            expectedLoadedState !== undefined &&
            Buffer.compare(Buffer.from(persistedState), expectedLoadedState) === 0;
          if (!isFreshMigratedRow) return { rows: [], rowCount: 0 } as DbQueryResult<Row>;

          persistedState = new Uint8Array(params?.[1] as Buffer);
          stateFingerprint = params?.[3] as string;
          return { rows: [{ yjs_state_fingerprint: stateFingerprint } as Row], rowCount: 1 };
        }

        return { rows: [], rowCount: 0 } as DbQueryResult<Row>;
      },
    };

    const loaded = await loadYjsStateWithMetadata(pool, 'doc:doc_abc:branch:br_main');

    await expect(
      storeYjsState(pool, 'doc:doc_abc:branch:br_main', nextState, loaded.stateFingerprint, loaded.yjsState),
    ).resolves.toEqual({
      stored: true,
      stateFingerprint: expectedNextFingerprint,
    });

    expect(Array.from(persistedState)).toEqual(Array.from(nextState));
  });

  it('does not overwrite when branch state changed after the Hocuspocus document was loaded', async () => {
    const loadedState = createValidYjsState('loaded');
    const apiState = createValidYjsState('api');
    const staleHocuspocusState = createValidYjsState('stale');
    let persistedState = apiState;
    let stateFingerprint = '101';

    const pool: DbExecutor = {
      query: async <Row = unknown>(sql: string, params?: readonly unknown[]): Promise<DbQueryResult<Row>> => {
        if (sql.includes('select yjs_state')) {
          return {
            rows: [{ yjs_state: Buffer.from(loadedState), yjs_state_fingerprint: stateFingerprint }],
            rowCount: 1,
          } as DbQueryResult<Row>;
        }

        if (sql.includes('update document_branch_states')) {
          if (params?.[2] === stateFingerprint) {
            persistedState = new Uint8Array(params[1] as Buffer);
            stateFingerprint = '102';
            return { rows: [{ yjs_state_fingerprint: stateFingerprint } as Row], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 } as DbQueryResult<Row>;
        }

        return { rows: [], rowCount: 0 } as DbQueryResult<Row>;
      },
    };

    const loaded = await loadYjsStateWithMetadata(pool, 'doc:doc_abc:branch:br_main');
    stateFingerprint = '201';

    await expect(
      storeYjsState(pool, 'doc:doc_abc:branch:br_main', staleHocuspocusState, loaded.stateFingerprint),
    ).resolves.toEqual({ stored: false });

    expect(Array.from(persistedState)).toEqual(Array.from(apiState));
  });

  it('binds freshness to the loaded document instead of the latest room load', async () => {
    const firstLoadedState = createValidYjsState('first');
    const apiState = createValidYjsState('api');
    const secondStore = createValidYjsState('second');
    const staleFirstStore = createValidYjsState('stale');
    let persistedState = firstLoadedState;
    let stateFingerprint = '101';

    const pool: DbExecutor = {
      query: async <Row = unknown>(sql: string, params?: readonly unknown[]): Promise<DbQueryResult<Row>> => {
        if (sql.includes('select yjs_state')) {
          return {
            rows: [{ yjs_state: Buffer.from(persistedState), yjs_state_fingerprint: stateFingerprint }],
            rowCount: 1,
          } as DbQueryResult<Row>;
        }

        if (sql.includes('update document_branch_states')) {
          if (params?.[2] !== stateFingerprint) return { rows: [], rowCount: 0 } as DbQueryResult<Row>;
          persistedState = new Uint8Array(params[1] as Buffer);
          stateFingerprint = stateFingerprint === '102' ? '103' : '104';
          return { rows: [{ yjs_state_fingerprint: stateFingerprint } as Row], rowCount: 1 };
        }

        return { rows: [], rowCount: 0 } as DbQueryResult<Row>;
      },
    };

    const firstLoad = await loadYjsStateWithMetadata(pool, 'doc:doc_abc:branch:br_main');
    persistedState = apiState;
    stateFingerprint = '102';
    const secondLoad = await loadYjsStateWithMetadata(pool, 'doc:doc_abc:branch:br_main');

    await expect(
      storeYjsState(pool, 'doc:doc_abc:branch:br_main', staleFirstStore, firstLoad.stateFingerprint),
    ).resolves.toEqual({ stored: false });
    await expect(storeYjsState(pool, 'doc:doc_abc:branch:br_main', secondStore, secondLoad.stateFingerprint)).resolves.toEqual({
      stored: true,
      stateFingerprint: '103',
    });

    expect(Array.from(persistedState)).toEqual(Array.from(secondStore));
  });

  it('updates the loaded state fingerprint after a fresh Hocuspocus store succeeds', async () => {
    const loadedState = createValidYjsState('loaded');
    const firstStore = createValidYjsState('first');
    const secondStore = createValidYjsState('second');
    let persistedState = loadedState;
    let stateFingerprint = '101';
    const updateParams: (readonly unknown[] | undefined)[] = [];

    const pool: DbExecutor = {
      query: async <Row = unknown>(sql: string, params?: readonly unknown[]): Promise<DbQueryResult<Row>> => {
        if (sql.includes('select yjs_state')) {
          return {
            rows: [{ yjs_state: Buffer.from(loadedState), yjs_state_fingerprint: stateFingerprint }],
            rowCount: 1,
          } as DbQueryResult<Row>;
        }

        if (sql.includes('update document_branch_states')) {
          updateParams.push(params);
          if (params?.[2] !== stateFingerprint) return { rows: [], rowCount: 0 } as DbQueryResult<Row>;
          persistedState = new Uint8Array(params[1] as Buffer);
          stateFingerprint = stateFingerprint === '101' ? '102' : '103';
          return { rows: [{ yjs_state_fingerprint: stateFingerprint } as Row], rowCount: 1 };
        }

        return { rows: [], rowCount: 0 } as DbQueryResult<Row>;
      },
    };

    const loaded = await loadYjsStateWithMetadata(pool, 'doc:doc_abc:branch:br_main');
    const firstResult = await storeYjsState(pool, 'doc:doc_abc:branch:br_main', firstStore, loaded.stateFingerprint);
    expect(firstResult).toEqual({ stored: true, stateFingerprint: '102' });

    const secondResult = await storeYjsState(
      pool,
      'doc:doc_abc:branch:br_main',
      secondStore,
      firstResult.stateFingerprint ?? null,
    );
    expect(secondResult).toEqual({ stored: true, stateFingerprint: '103' });

    expect(Array.from(persistedState)).toEqual(Array.from(secondStore));
    expect(updateParams.map((params) => params?.[2])).toEqual(['101', '102']);
  });

  it('does not store without a state fingerprint for the loaded document', async () => {
    let persistedState = createValidYjsState('persisted');
    const initialPersistedState = persistedState;
    const pool: DbExecutor = {
      query: async <Row = unknown>(sql: string, params?: readonly unknown[]): Promise<DbQueryResult<Row>> => {
        if (sql.includes('update document_branch_states')) {
          persistedState = new Uint8Array(params?.[1] as Buffer);
          return { rows: [{ yjs_state_fingerprint: '102' } as Row], rowCount: 1 };
        }

        return { rows: [], rowCount: 0 } as DbQueryResult<Row>;
      },
    };

    await expect(
      storeYjsState(pool, 'doc:doc_without_load:branch:br_main', createValidYjsState('ignored'), null),
    ).resolves.toEqual({ stored: false });

    expect(Array.from(persistedState)).toEqual(Array.from(initialPersistedState));
  });
});
