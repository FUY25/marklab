import { afterEach, describe, expect, it } from 'vitest';
import { sha256Hex } from '@marklab/shared/src/hash';
import * as Y from 'yjs';
import type { DbPool, DbQueryResult, DbTransactionClient } from '../db/client';
import { encodeYjsStateFingerprint } from '../services/yjs-state-fingerprint';
import { toRoomName } from './persistence';
import { createCollabServer } from './server';

interface TestableHocuspocus {
  configuration: {
    onAuthenticate(payload: { documentName: string; token: string }): Promise<void>;
    onLoadDocument(payload: { documentName: string; document: Y.Doc }): Promise<Uint8Array | null>;
    onStoreDocument(payload: { documentName: string; document: Y.Doc }): Promise<void>;
    afterUnloadDocument(payload: { documentName: string }): Promise<void>;
  };
  destroy?(): Promise<void> | void;
}

interface TestableCollabServer {
  server: TestableHocuspocus;
  flushDocument(roomName: string): Promise<void>;
  applyDocumentState(roomName: string, yjsState: Uint8Array): Promise<void>;
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

function createPersistencePool(
  initialState: Uint8Array,
  options: {
    failStoreAttempts?: number;
    agentTokens?: Array<{
      tokenHash: string;
      docId: string;
      branchId: string | null;
      canRead: boolean;
      canWrite: boolean;
    }>;
    shareLinks?: Array<{
      tokenHash: string;
      docId: string;
      branchId: string | null;
      role: 'view' | 'edit';
    }>;
  } = {},
) {
  let persistedState = initialState;
  let stateFingerprint = encodeYjsStateFingerprint(initialState);
  let storeAttemptCount = 0;

  const query: DbPool['query'] = async <Row = unknown>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<DbQueryResult<Row>> => {
    if (sql.includes('from agent_tokens')) {
      const [tokenHash, docId, branchId] = params ?? [];
      return {
        rows: (options.agentTokens ?? [])
          .filter((row) => row.tokenHash === tokenHash && row.docId === docId && (row.branchId === branchId || row.branchId === null))
          .map((row) => ({
            can_read: row.canRead,
            can_write: row.canWrite,
            expires_at: null,
            revoked_at: null,
          })) as Row[],
        rowCount: 1,
      };
    }

    if (sql.includes('from share_links')) {
      const [tokenHash, docId, branchId] = params ?? [];
      return {
        rows: (options.shareLinks ?? [])
          .filter((row) => row.tokenHash === tokenHash && row.docId === docId && (row.branchId === branchId || row.branchId === null))
          .map((row) => ({
            role: row.role,
            expires_at: null,
            revoked_at: null,
          })) as Row[],
        rowCount: 1,
      };
    }

    if (sql.includes('select yjs_state, yjs_state_fingerprint')) {
      return {
        rows: [{ yjs_state: Buffer.from(persistedState), yjs_state_fingerprint: stateFingerprint } as Row],
        rowCount: 1,
      };
    }

    if (sql.includes('update document_branch_states')) {
      storeAttemptCount += 1;
      if (storeAttemptCount <= (options.failStoreAttempts ?? 0)) {
        return { rows: [], rowCount: 0 } as DbQueryResult<Row>;
      }

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

const originalRequireAuth = process.env.MARKLAB_REQUIRE_AUTH;

afterEach(() => {
  process.env.MARKLAB_REQUIRE_AUTH = originalRequireAuth;
});

function enableAuthMode() {
  process.env.MARKLAB_REQUIRE_AUTH = 'true';
}

describe('createCollabServer persistence hooks', () => {
  it('flushes an active document without waiting for the Hocuspocus store timer', async () => {
    const initialState = createState('loaded');
    const store = createPersistencePool(initialState);
    const collab = createCollabServer(store.pool) as unknown as TestableCollabServer;
    const document = new Y.Doc();
    const roomName = toRoomName('doc_001', 'br_main');

    try {
      const loadedState = await collab.server.configuration.onLoadDocument({ documentName: roomName, document });
      expect(loadedState).toBeInstanceOf(Uint8Array);
      Y.applyUpdate(document, loadedState ?? new Uint8Array());
      document.getText('prosemirror').insert(document.getText('prosemirror').length, ' active');

      await collab.flushDocument(roomName);

      expect(store.getStoreAttemptCount()).toBe(1);
      expect(textFromState(store.getPersistedState())).toBe('loaded active');
    } finally {
      document.destroy();
      await collab.server.destroy?.();
    }
  });

  it('forgets an active document after Hocuspocus unload so later flushes are no-ops', async () => {
    const initialState = createState('loaded');
    const store = createPersistencePool(initialState);
    const collab = createCollabServer(store.pool) as unknown as TestableCollabServer;
    const document = new Y.Doc();
    const roomName = toRoomName('doc_001', 'br_main');

    try {
      const loadedState = await collab.server.configuration.onLoadDocument({ documentName: roomName, document });
      expect(loadedState).toBeInstanceOf(Uint8Array);
      Y.applyUpdate(document, loadedState ?? new Uint8Array());
      document.getText('prosemirror').insert(document.getText('prosemirror').length, ' active');

      await collab.server.configuration.afterUnloadDocument({ documentName: roomName });
      await collab.flushDocument(roomName);

      expect(store.getStoreAttemptCount()).toBe(0);
      expect(textFromState(store.getPersistedState())).toBe('loaded');
    } finally {
      document.destroy();
      await collab.server.destroy?.();
    }
  });

  it('retries an active flush after refreshing stale persistence metadata', async () => {
    const initialState = createState('loaded');
    const apiState = updateState(initialState, (text) => text.insert(text.length, ' api'));
    const store = createPersistencePool(initialState);
    const collab = createCollabServer(store.pool) as unknown as TestableCollabServer;
    const document = new Y.Doc();
    const roomName = toRoomName('doc_001', 'br_main');

    try {
      const loadedState = await collab.server.configuration.onLoadDocument({ documentName: roomName, document });
      expect(loadedState).toBeInstanceOf(Uint8Array);
      Y.applyUpdate(document, loadedState ?? new Uint8Array());
      document.getText('prosemirror').insert(document.getText('prosemirror').length, ' human');

      store.replacePersistedState(apiState);

      await collab.flushDocument(roomName);

      expect(store.getStoreAttemptCount()).toBe(2);
      expect(textFromState(store.getPersistedState())).toContain('api');
      expect(textFromState(store.getPersistedState())).toContain('human');
    } finally {
      document.destroy();
      await collab.server.destroy?.();
    }
  });

  it('fails closed when an explicit active flush cannot persist after one retry', async () => {
    const initialState = createState('loaded');
    const store = createPersistencePool(initialState, { failStoreAttempts: 2 });
    const collab = createCollabServer(store.pool) as unknown as TestableCollabServer;
    const document = new Y.Doc();
    const roomName = toRoomName('doc_001', 'br_main');

    try {
      const loadedState = await collab.server.configuration.onLoadDocument({ documentName: roomName, document });
      expect(loadedState).toBeInstanceOf(Uint8Array);
      Y.applyUpdate(document, loadedState ?? new Uint8Array());
      document.getText('prosemirror').insert(document.getText('prosemirror').length, ' active');

      await expect(collab.flushDocument(roomName)).rejects.toThrow('active_collab_flush_failed');

      expect(store.getStoreAttemptCount()).toBe(2);
      expect(textFromState(store.getPersistedState())).toBe('loaded');
    } finally {
      document.destroy();
      await collab.server.destroy?.();
    }
  });

  it('recovers after an API write wins the Yjs persistence race for an open document', async () => {
    const initialState = createState('loaded');
    const apiState = updateState(initialState, (text) => text.insert(text.length, ' api'));
    const store = createPersistencePool(initialState);
    const collab = createCollabServer(store.pool) as unknown as TestableCollabServer;
    const document = new Y.Doc();
    const roomName = toRoomName('doc_001', 'br_main');

    try {
      const loadedState = await collab.server.configuration.onLoadDocument({ documentName: roomName, document });
      expect(loadedState).toBeInstanceOf(Uint8Array);
      Y.applyUpdate(document, loadedState ?? new Uint8Array());
      document.getText('prosemirror').insert(document.getText('prosemirror').length, ' human');

      store.replacePersistedState(apiState);

      await collab.server.configuration.onStoreDocument({ documentName: roomName, document });

      expect(store.getStoreAttemptCount()).toBe(2);
      expect(textFromState(store.getPersistedState())).toContain('api');
      expect(textFromState(store.getPersistedState())).toContain('human');

      document.getText('prosemirror').insert(document.getText('prosemirror').length, ' again');
      await collab.server.configuration.onStoreDocument({ documentName: roomName, document });

      expect(textFromState(store.getPersistedState())).toContain('again');
    } finally {
      document.destroy();
      await collab.server.destroy?.();
    }
  });

  it('applies a committed REST Yjs state to an active room before the next store', async () => {
    const initialState = createState('loaded');
    const apiState = updateState(initialState, (text) => {
      text.delete(0, text.length);
      text.insert(0, 'api result');
    });
    const store = createPersistencePool(initialState);
    const collab = createCollabServer(store.pool) as unknown as TestableCollabServer;
    const document = new Y.Doc();
    const roomName = toRoomName('doc_001', 'br_main');

    try {
      const loadedState = await collab.server.configuration.onLoadDocument({ documentName: roomName, document });
      expect(loadedState).toBeInstanceOf(Uint8Array);
      Y.applyUpdate(document, loadedState ?? new Uint8Array());

      store.replacePersistedState(apiState);
      await collab.applyDocumentState(roomName, apiState);

      expect(textFromState(Y.encodeStateAsUpdate(document))).toBe('api result');

      await collab.server.configuration.onStoreDocument({ documentName: roomName, document });

      expect(store.getStoreAttemptCount()).toBe(1);
      expect(textFromState(store.getPersistedState())).toBe('api result');
    } finally {
      document.destroy();
      await collab.server.destroy?.();
    }
  });

  it('rejects missing provider tokens when auth is required', async () => {
    enableAuthMode();
    const initialState = createState('loaded');
    const store = createPersistencePool(initialState);
    const collab = createCollabServer(store.pool) as unknown as TestableCollabServer;

    try {
      await expect(
        collab.server.configuration.onAuthenticate({
          documentName: toRoomName('doc_001', 'br_main'),
          token: '',
        }),
      ).rejects.toThrow('forbidden');
    } finally {
      await collab.server.destroy?.();
    }
  });

  it('accepts edit share tokens for the target branch when auth is required', async () => {
    enableAuthMode();
    const shareToken = 'ml_share_edit';
    const initialState = createState('loaded');
    const store = createPersistencePool(initialState, {
      shareLinks: [
        {
          tokenHash: sha256Hex(shareToken),
          docId: 'doc_001',
          branchId: 'br_main',
          role: 'edit',
        },
      ],
    });
    const collab = createCollabServer(store.pool) as unknown as TestableCollabServer;

    try {
      await expect(
        collab.server.configuration.onAuthenticate({
          documentName: toRoomName('doc_001', 'br_main'),
          token: shareToken,
        }),
      ).resolves.toBeUndefined();
    } finally {
      await collab.server.destroy?.();
    }
  });
});
