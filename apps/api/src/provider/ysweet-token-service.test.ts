import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClientToken } from '@y-sweet/sdk';
import * as Y from 'yjs';
import { PROVIDER_TOKEN_TTL_SECONDS } from '../config/provider-token-policy';
import {
  createHeadlessMilkdownRuntime,
  readProviderContentsMarkdownFromYjsState,
} from '../services/milkdown-headless-runtime';
import {
  bindProviderSessionIdentity,
  createYSweetSnapshotService,
  createYSweetTokenService,
  encodeProviderSessionIdentity,
  type YSweetDocumentManagerLike,
} from './ysweet-token-service';

function createFakeManager(): YSweetDocumentManagerLike & {
  calls: Array<{ method: string; docId?: string; authorization?: string; validForSeconds?: number }>;
  updates: Array<{ docId: string; update: Uint8Array }>;
  events: string[];
} {
  const calls: Array<{ method: string; docId?: string; authorization?: string; validForSeconds?: number }> = [];
  const updates: Array<{ docId: string; update: Uint8Array }> = [];
  const events: string[] = [];
  function clientToken(docId: string, authorization?: ClientToken['authorization']): ClientToken {
    const token: ClientToken = {
      url: 'ws://ysweet.example.test',
      baseUrl: 'http://ysweet.example.test/doc/ml_doc_1',
      docId,
      token: 'ysweet_token',
    };
    if (authorization !== undefined) token.authorization = authorization;
    return token;
  }
  return {
    calls,
    updates,
    events,
    async createDoc(docId) {
      const call: { method: string; docId?: string } = { method: 'createDoc' };
      if (docId !== undefined) call.docId = docId;
      calls.push(call);
      events.push(`create:${docId ?? 'ml_doc_generated'}`);
      return { docId: docId ?? 'ml_doc_generated' };
    },
    async getClientToken(docId, request) {
      const resolvedDocId = typeof docId === 'string' ? docId : docId.docId;
      const call: { method: string; docId?: string; authorization?: string; validForSeconds?: number } = {
        method: 'getClientToken',
        docId: resolvedDocId,
      };
      if (request?.authorization !== undefined) call.authorization = request.authorization;
      if (request?.validForSeconds !== undefined) call.validForSeconds = request.validForSeconds;
      calls.push(call);
      events.push(`token:${resolvedDocId}`);
      return clientToken(resolvedDocId, request?.authorization);
    },
    async getOrCreateDocAndToken(docId, request) {
      const call: { method: string; docId?: string; authorization?: string; validForSeconds?: number } = { method: 'getOrCreateDocAndToken' };
      if (docId !== undefined) call.docId = docId;
      if (request?.authorization !== undefined) call.authorization = request.authorization;
      if (request?.validForSeconds !== undefined) call.validForSeconds = request.validForSeconds;
      calls.push(call);
      events.push(`getOrCreateToken:${docId ?? 'ml_doc_generated'}`);
      return clientToken(docId ?? 'ml_doc_generated', request?.authorization);
    },
    async updateDoc(docId, update) {
      updates.push({ docId, update });
      events.push(`update:${docId}`);
    },
  };
}

describe('createYSweetTokenService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('issues full edit tokens with the configured default ttl', async () => {
    const manager = createFakeManager();
    const service = createYSweetTokenService({ manager });

    const issued = await service.issueProviderToken({
      providerDocId: 'ml_doc_1',
      sessionId: 'session_1',
      authorization: 'full',
    });

    expect(manager.calls).toEqual([{
      method: 'getOrCreateDocAndToken',
      docId: 'ml_doc_1',
      authorization: 'full',
      validForSeconds: PROVIDER_TOKEN_TTL_SECONDS,
    }]);
    expect(issued).toMatchObject({
      providerDocId: 'ml_doc_1',
      sessionId: 'session_1',
      authorization: 'full',
      validForSeconds: PROVIDER_TOKEN_TTL_SECONDS,
      clientToken: {
        docId: 'ml_doc_1',
        token: 'ysweet_token',
      },
    });
  });

  it('carries server-derived session identity alongside the provider client token', async () => {
    const manager = createFakeManager();
    const service = createYSweetTokenService({ manager });

    const issued = await service.issueProviderToken({
      providerDocId: 'ml_doc_1',
      sessionId: 'session_1',
      authorization: 'full',
      sessionIdentity: {
        sessionId: 'session_1',
        actorType: 'user',
        actorId: 'access:server-token-hash',
        displayName: 'Alice',
        isGuest: false,
      },
    });

    expect(issued.sessionIdentity).toEqual({
      sessionId: 'session_1',
      actorType: 'user',
      actorId: 'access:server-token-hash',
      displayName: 'Alice',
      isGuest: false,
    });
  });

  it('binds server-derived identity to the current Yjs client id for UI attribution', () => {
    const ydoc = new Y.Doc();
    try {
      const identity = {
        sessionId: 'session_1',
        actorType: 'user' as const,
        actorId: 'grant:grant_1',
        displayName: 'Alice',
        isGuest: false,
      };

      const permanentUserData = bindProviderSessionIdentity(ydoc, identity);

      expect(permanentUserData.getUserByClientId(ydoc.clientID)).toBe(encodeProviderSessionIdentity(identity));
    } finally {
      ydoc.destroy();
    }
  });

  it('passes read-only authorization and explicit ttl through to Y-Sweet', async () => {
    const manager = createFakeManager();
    const service = createYSweetTokenService({ manager, defaultValidForSeconds: PROVIDER_TOKEN_TTL_SECONDS });
    const explicitTtlSeconds = PROVIDER_TOKEN_TTL_SECONDS / 5;

    const issued = await service.issueProviderToken({
      providerDocId: 'ml_doc_2',
      sessionId: 'session_2',
      authorization: 'read-only',
      validForSeconds: explicitTtlSeconds,
    });

    expect(manager.calls).toEqual([{
      method: 'getOrCreateDocAndToken',
      docId: 'ml_doc_2',
      authorization: 'read-only',
      validForSeconds: explicitTtlSeconds,
    }]);
    expect(issued.authorization).toBe('read-only');
    expect(issued.validForSeconds).toBe(explicitTtlSeconds);
  });

  it('seeds newly allocated provider documents before minting the client token', async () => {
    const manager = createFakeManager();
    const service = createYSweetTokenService({ manager });
    const runtime = createHeadlessMilkdownRuntime();
    const seedYjsState = (await runtime.initializeFromMarkdown('# Seeded\n')).yjsState;

    await service.issueProviderToken({
      providerDocId: 'ml_doc_seeded',
      sessionId: 'session_seed',
      authorization: 'full',
      seedYjsState,
    });

    expect(manager.calls).toEqual([
      { method: 'createDoc', docId: 'ml_doc_seeded' },
      {
        method: 'getClientToken',
        docId: 'ml_doc_seeded',
        authorization: 'full',
        validForSeconds: PROVIDER_TOKEN_TTL_SECONDS,
      },
    ]);
    expect(manager.updates).toHaveLength(1);
    expect(manager.updates[0]?.docId).toBe('ml_doc_seeded');
    expect(manager.events).toEqual(['create:ml_doc_seeded', 'update:ml_doc_seeded', 'token:ml_doc_seeded']);
  });

  it('converts canonical branch Yjs state to browser contents text before seeding Y-Sweet', async () => {
    const runtime = createHeadlessMilkdownRuntime();
    const branchState = await runtime.initializeFromMarkdown('# Seeded browser doc\n\nInitial body.\n');
    const manager = createFakeManager();
    const service = createYSweetTokenService({ manager });

    await service.issueProviderToken({
      providerDocId: 'ml_doc_seeded',
      sessionId: 'session_seed',
      authorization: 'full',
      seedYjsState: branchState.yjsState,
    });

    const update = manager.updates[0]?.update;
    expect(update).toBeDefined();
    const seeded = new Y.Doc();
    try {
      Y.applyUpdate(seeded, update!);
      expect(seeded.getText('contents').toString()).toBe('# Seeded browser doc\n\nInitial body.\n');
    } finally {
      seeded.destroy();
    }
  });

  it('rejects a seeded provider document when Y-Sweet returns a different document id', async () => {
    const manager = createFakeManager();
    manager.createDoc = async () => ({ docId: 'ml_doc_different' });
    const service = createYSweetTokenService({ manager });

    await expect(service.issueProviderToken({
      providerDocId: 'ml_doc_seeded',
      sessionId: 'session_seed',
      authorization: 'full',
      seedYjsState: new Uint8Array([1, 2, 3]),
    })).rejects.toThrow('ysweet_provider_doc_id_mismatch');

    expect(manager.updates).toEqual([]);
  });

  it('can reseed an existing provider document idempotently after a marker write failure', async () => {
    const manager = createFakeManager();
    const service = createYSweetTokenService({ manager });
    const runtime = createHeadlessMilkdownRuntime();
    const seedYjsState = (await runtime.initializeFromMarkdown('# Retry seed\n')).yjsState;

    await service.issueProviderToken({
      providerDocId: 'ml_doc_seeded',
      sessionId: 'session_first',
      authorization: 'full',
      seedYjsState,
    });
    await service.issueProviderToken({
      providerDocId: 'ml_doc_seeded',
      sessionId: 'session_retry',
      authorization: 'full',
      seedYjsState,
    });

    expect(manager.calls.filter((call) => call.method === 'createDoc')).toEqual([
      { method: 'createDoc', docId: 'ml_doc_seeded' },
      { method: 'createDoc', docId: 'ml_doc_seeded' },
    ]);
    expect(manager.updates.map((update) => update.docId)).toEqual(['ml_doc_seeded', 'ml_doc_seeded']);
    const providerDoc = new Y.Doc();
    try {
      for (const update of manager.updates) {
        Y.applyUpdate(providerDoc, update.update);
      }
      expect(providerDoc.getText('contents').toString()).toBe('# Retry seed\n');
    } finally {
      providerDoc.destroy();
    }
  });

  it('migrates already-seeded Milkdown provider state to browser contents before minting a token', async () => {
    const runtime = createHeadlessMilkdownRuntime();
    const existingProviderState = await runtime.initializeFromMarkdown('# Existing provider doc\n\nOld shape.\n');
    let providerState = existingProviderState.yjsState;
    const manager = createFakeManager();
    manager.getDocAsUpdate = vi.fn(async () => providerState);
    manager.updateDoc = async (docId, update) => {
      manager.updates.push({ docId, update });
      const providerDoc = new Y.Doc();
      try {
        Y.applyUpdate(providerDoc, providerState);
        Y.applyUpdate(providerDoc, update);
        providerState = Y.encodeStateAsUpdate(providerDoc);
      } finally {
        providerDoc.destroy();
      }
    };
    const service = createYSweetTokenService({ manager });

    await service.issueProviderToken({
      providerDocId: 'ml_doc_existing',
      sessionId: 'session_existing',
      authorization: 'full',
      ensureProviderContentsState: true,
    });

    expect(manager.getDocAsUpdate).toHaveBeenCalledWith('ml_doc_existing');
    expect(manager.updates.map((update) => update.docId)).toEqual(['ml_doc_existing']);
    const migrated = new Y.Doc();
    try {
      Y.applyUpdate(migrated, providerState);
      expect(migrated.getText('contents').toString()).toBe('# Existing provider doc\n\nOld shape.\n');
    } finally {
      migrated.destroy();
    }
  });

  it('replaces stale provider contents when a changed seed retries after marker failure', async () => {
    const runtime = createHeadlessMilkdownRuntime();
    const firstSeed = await runtime.initializeFromMarkdown('# First seed\n');
    const retrySeed = await runtime.initializeFromMarkdown('# Retry changed seed\n');
    let providerState = Y.encodeStateAsUpdate(new Y.Doc());
    const manager = createFakeManager();
    manager.getDocAsUpdate = vi.fn(async () => providerState);
    manager.updateDoc = async (docId, update) => {
      manager.updates.push({ docId, update });
      const providerDoc = new Y.Doc();
      try {
        Y.applyUpdate(providerDoc, providerState);
        Y.applyUpdate(providerDoc, update);
        providerState = Y.encodeStateAsUpdate(providerDoc);
      } finally {
        providerDoc.destroy();
      }
    };
    const service = createYSweetTokenService({ manager });

    await service.issueProviderToken({
      providerDocId: 'ml_doc_seeded',
      sessionId: 'session_first',
      authorization: 'full',
      seedYjsState: firstSeed.yjsState,
    });
    await service.issueProviderToken({
      providerDocId: 'ml_doc_seeded',
      sessionId: 'session_retry',
      authorization: 'full',
      seedYjsState: retrySeed.yjsState,
    });

    const providerDoc = new Y.Doc();
    try {
      Y.applyUpdate(providerDoc, providerState);
      expect(providerDoc.getText('contents').toString()).toBe('# Retry changed seed\n');
    } finally {
      providerDoc.destroy();
    }
  });

  it('starts the reported token TTL before waiting on the Y-Sweet manager', async () => {
    let nowMs = Date.parse('2026-05-11T00:00:00.000Z');
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    const manager: YSweetDocumentManagerLike = {
      async createDoc(docId) {
        return { docId: docId ?? 'ml_doc_generated' };
      },
      async getClientToken() {
        throw new Error('not_used');
      },
      async getOrCreateDocAndToken(docId, request) {
        nowMs = Date.parse('2026-05-11T00:00:03.000Z');
        const clientToken: ClientToken = {
          url: 'ws://ysweet.example.test',
          baseUrl: 'http://ysweet.example.test/doc/ml_doc_3',
          docId: docId ?? 'ml_doc_generated',
          token: 'ysweet_token',
        };
        if (request?.authorization !== undefined) clientToken.authorization = request.authorization;
        return clientToken;
      },
      async updateDoc() {
        throw new Error('not_used');
      },
    };
    const service = createYSweetTokenService({ manager, defaultValidForSeconds: PROVIDER_TOKEN_TTL_SECONDS });

    const issued = await service.issueProviderToken({
      providerDocId: 'ml_doc_3',
      sessionId: 'session_3',
      authorization: 'full',
    });

    expect(issued.issuedAt).toBe('2026-05-11T00:00:00.000Z');
    expect(issued.expiresAt).toBe('2026-05-11T00:10:00.000Z');
  });

  it('falls back to the control-plane snapshot path when no provider document exists yet', async () => {
    const manager = createFakeManager();
    const service = createYSweetSnapshotService({
      pool: {
        async query<Row = unknown>() {
          return { rows: [{ provider_doc_id: null } as Row], rowCount: 1 };
        },
      } as never,
      manager,
    });

    await expect(service.readCurrentMarkdownSnapshot({ docId: 'doc_1', branchId: 'branch_1' }))
      .resolves.toBeNull();
  });

  it('fails closed when a seeded provider document cannot be read for snapshots', async () => {
    const manager = createFakeManager();
    const service = createYSweetSnapshotService({
      pool: {
        async query<Row = unknown>() {
          return {
            rows: [{
              provider_doc_id: 'ml_doc_current',
              provider_doc_seeded_at: '2026-05-11T00:00:00.000Z',
            } as Row],
            rowCount: 1,
          };
        },
      } as never,
      manager,
    });

    await expect(service.readCurrentMarkdownSnapshot({ docId: 'doc_1', branchId: 'branch_1' }))
      .rejects.toThrow('collab_snapshot_unavailable');
  });

  it('fails closed when a provider document exists without a seed marker', async () => {
    const manager: YSweetDocumentManagerLike = {
      async createDoc(docId) {
        return { docId: docId ?? 'ml_doc_generated' };
      },
      async getClientToken() {
        throw new Error('not_used');
      },
      async getOrCreateDocAndToken() {
        throw new Error('not_used');
      },
      getDocAsUpdate: vi.fn(async () => new Uint8Array()),
      async updateDoc() {
        throw new Error('not_used');
      },
    };
    const service = createYSweetSnapshotService({
      pool: {
        async query<Row = unknown>() {
          return { rows: [{ provider_doc_id: 'ml_doc_current', provider_doc_seeded_at: null } as Row], rowCount: 1 };
        },
      } as never,
      manager,
    });

    await expect(service.readCurrentMarkdownSnapshot({ docId: 'doc_1', branchId: 'branch_1' }))
      .rejects.toThrow('collab_snapshot_unavailable');
    expect(manager.getDocAsUpdate).not.toHaveBeenCalled();
  });

  it('reads current Markdown snapshots from Y-Sweet provider state', async () => {
    const runtime = createHeadlessMilkdownRuntime();
    const providerState = await runtime.initializeFromMarkdown('# Provider current\n');
    const manager: YSweetDocumentManagerLike & { reads: string[] } = {
      reads: [],
      async createDoc(docId) {
        return { docId: docId ?? 'ml_doc_generated' };
      },
      async getClientToken() {
        throw new Error('not_used');
      },
      async getOrCreateDocAndToken() {
        throw new Error('not_used');
      },
      async getDocAsUpdate(docId) {
        this.reads.push(docId);
        return providerState.yjsState;
      },
      async updateDoc() {
        throw new Error('not_used');
      },
    };
    const queries: Array<{ sql: string; params: readonly unknown[] }> = [];
    const pool = {
      async query<Row = unknown>(sql: string, params: readonly unknown[] = []) {
        queries.push({ sql, params });
        return {
          rows: [{
            provider_doc_id: 'ml_doc_current',
            provider_doc_seeded_at: '2026-05-11T00:00:00.000Z',
          } as Row],
          rowCount: 1,
        };
      },
    };
    const service = createYSweetSnapshotService({ pool: pool as never, manager });

    await expect(service.readCurrentMarkdownSnapshot({ docId: 'doc_1', branchId: 'branch_1' })).resolves.toMatchObject({
      docId: 'doc_1',
      branchId: 'branch_1',
      versionId: null,
      versionNumber: null,
      markdown: '# Provider current\n',
      hash: providerState.hash,
    });
    expect(manager.reads).toEqual(['ml_doc_current']);
    expect(queries[0]?.params).toEqual(['branch_1', 'doc_1']);
    expect(queries[0]?.sql).toContain('join document_branches');
    expect(queries[0]?.sql).toContain('b.doc_id = $2');
  });

  it('applies Markdown snapshots back to Y-Sweet provider contents', async () => {
    const providerDoc = new Y.Doc();
    providerDoc.getText('contents').insert(0, '# Before restore\n');
    const providerState = Y.encodeStateAsUpdate(providerDoc);
    providerDoc.destroy();
    const updates: Array<{ docId: string; update: Uint8Array }> = [];
    const manager: YSweetDocumentManagerLike = {
      async createDoc(docId) {
        return { docId: docId ?? 'ml_doc_generated' };
      },
      async getClientToken() {
        throw new Error('not_used');
      },
      async getOrCreateDocAndToken() {
        throw new Error('not_used');
      },
      async getDocAsUpdate() {
        return providerState;
      },
      async updateDoc(docId, update) {
        updates.push({ docId, update });
      },
    };
    const service = createYSweetSnapshotService({
      pool: {
        async query<Row = unknown>() {
          return {
            rows: [{
              provider_doc_id: 'ml_doc_current',
              provider_doc_seeded_at: '2026-05-11T00:00:00.000Z',
            } as Row],
            rowCount: 1,
          };
        },
      } as never,
      manager,
    });

    await service.applyMarkdownSnapshot?.({
      docId: 'doc_1',
      branchId: 'branch_1',
      markdown: '# Restored provider\n',
    });

    expect(updates).toHaveLength(1);
    expect(updates[0]?.docId).toBe('ml_doc_current');
    const updatedDoc = new Y.Doc();
    Y.applyUpdate(updatedDoc, providerState);
    Y.applyUpdate(updatedDoc, updates[0]!.update);
    expect(readProviderContentsMarkdownFromYjsState(Y.encodeStateAsUpdate(updatedDoc))).toBe('# Restored provider\n');
    updatedDoc.destroy();
  });

  it('reads browser contents text provider state as current Markdown snapshots', async () => {
    const providerDoc = new Y.Doc();
    providerDoc.getText('contents').insert(0, '# Browser current\n\nEdited in web.\n');
    const providerState = Y.encodeStateAsUpdate(providerDoc);
    providerDoc.destroy();
    const manager: YSweetDocumentManagerLike = {
      async createDoc(docId) {
        return { docId: docId ?? 'ml_doc_generated' };
      },
      async getClientToken() {
        throw new Error('not_used');
      },
      async getOrCreateDocAndToken() {
        throw new Error('not_used');
      },
      async getDocAsUpdate() {
        return providerState;
      },
      async updateDoc() {
        throw new Error('not_used');
      },
    };
    const service = createYSweetSnapshotService({
      pool: {
        async query<Row = unknown>() {
          return {
            rows: [{
              provider_doc_id: 'ml_doc_current',
              provider_doc_seeded_at: '2026-05-11T00:00:00.000Z',
            } as Row],
            rowCount: 1,
          };
        },
      } as never,
      manager,
    });

    await expect(service.readCurrentMarkdownSnapshot({ docId: 'doc_1', branchId: 'branch_1' })).resolves.toMatchObject({
      docId: 'doc_1',
      branchId: 'branch_1',
      markdown: '# Browser current\n\nEdited in web.\n',
    });
  });

  it('maps provider snapshot read failures to an explicit unavailable error', async () => {
    const manager: YSweetDocumentManagerLike = {
      async createDoc(docId) {
        return { docId: docId ?? 'ml_doc_generated' };
      },
      async getClientToken() {
        throw new Error('not_used');
      },
      async getOrCreateDocAndToken() {
        throw new Error('not_used');
      },
      async getDocAsUpdate() {
        throw new Error('network_drop');
      },
      async updateDoc() {
        throw new Error('not_used');
      },
    };
    const service = createYSweetSnapshotService({
      pool: {
        async query<Row = unknown>() {
          return {
            rows: [{
              provider_doc_id: 'ml_doc_current',
              provider_doc_seeded_at: '2026-05-11T00:00:00.000Z',
            } as Row],
            rowCount: 1,
          };
        },
      } as never,
      manager,
    });

    await expect(service.readCurrentMarkdownSnapshot({ docId: 'doc_1', branchId: 'branch_1' }))
      .rejects.toThrow('collab_snapshot_unavailable');
  });
});
