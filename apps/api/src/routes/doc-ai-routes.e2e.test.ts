import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { canonicalizeMarkdown } from '@marklab/markdown/src/canonicalize';
import { sha256Hex } from '@marklab/shared/src/hash';
import * as Y from 'yjs';
import type { DbPool, DbQueryResult, DbTransactionClient } from '../db/client';
import { createHttpApp, type HttpAppOptions, type HttpRequestAuth } from '../http/app';
import { createHeadlessMilkdownRuntime } from '../services/milkdown-headless-runtime';
import type { AppliedLiveMarkdownTransaction, LiveMarkdownTransaction, LiveMarkdownWriter } from '../services/live-writer';
import { createUnavailableLiveMarkdownWriter } from '../services/live-writer';
import { createPostgresLiveMarkdownWriter } from '../services/postgres-live-writer';
import { toRoomName } from '../collab/persistence';
import { verifyAdminToken, verifyDocumentAccess } from '../services/access-control';

const openAuth: HttpRequestAuth = {
  requireAdminAccess: async () => undefined,
  requireDocumentAccess: async () => ({ actorType: 'user' }),
};

function createDocAiTestApp(pool: DbPool, liveWriter: LiveMarkdownWriter, options: HttpAppOptions = {}) {
  return createHttpApp(pool, liveWriter, {
    enableLegacyDocAiRoutes: true,
    auth: openAuth,
    ...options,
  });
}

interface FakePoolOptions {
  currentMarkdown?: string;
  currentHash?: string;
  currentVersionId?: string;
  currentVersionNumber?: number;
  headHash?: string;
  lastAutosaveAt?: Date | null;
  pendingAutosaveHash?: string | null;
  pendingAutosaveFirstSeenAt?: Date | null;
  activeAutosaveStartedAt?: Date | null;
  versionIds?: string[];
  yjsState?: Uint8Array;
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
  accessGrants?: Array<{
    tokenHash: string;
    docId: string;
    branchId: string;
    role: 'view' | 'edit';
    revokedAt?: Date | string | null;
  }>;
}

interface CapturedQuery {
  sql: string;
  params?: readonly unknown[];
}

function createFakePool(options: FakePoolOptions = {}) {
  const queries: CapturedQuery[] = [];
  let currentMarkdown = options.currentMarkdown ?? '# Doc\n\nOld paragraph.\n';
  let currentHash = options.currentHash ?? 'sha256:current';
  let currentVersionId = options.currentVersionId ?? 'ver_001';
  let currentVersionNumber = options.currentVersionNumber ?? 1;
  let headHash = options.headHash ?? currentHash;
  let yjsState = options.yjsState ?? createValidYjsState();
  let stateFingerprint = '101';
  const versionIds = [...(options.versionIds ?? ['ver_002', 'ver_003'])];
  let nextVersionNumber = currentVersionNumber + 1;
  let pendingVersion:
    | {
        id: string;
        versionNumber: number;
        markdown: string;
        hash: string;
      }
    | undefined;

  const query: DbPool['query'] = async <Row = unknown>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<DbQueryResult<Row>> => {
    queries.push(params === undefined ? { sql } : { sql, params });

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
            id: 'share_1',
            role: row.role,
            expires_at: null,
            revoked_at: null,
          })) as Row[],
        rowCount: 1,
      };
    }

    if (sql.includes('from document_access_grants') && sql.includes('token_hash = $1')) {
      const [tokenHash, docId, branchId] = params ?? [];
      return {
        rows: (options.accessGrants ?? [])
          .filter((row) => row.tokenHash === tokenHash && row.docId === docId && row.branchId === branchId)
          .map((row) => ({
            id: 'agr_1',
            role: row.role,
            expires_at: null,
            revoked_at: row.revokedAt ?? null,
          })) as Row[],
        rowCount: 1,
      };
    }

    if (sql.includes('from document_branches b') && sql.includes('document_branch_states')) {
      return {
        rows: [
          {
            yjs_state: Buffer.from(yjsState),
            current_markdown: currentMarkdown,
            current_hash: currentHash,
            head_version_id: currentVersionId,
            head_version_number: currentVersionNumber,
            head_hash: headHash,
            yjs_state_fingerprint: stateFingerprint,
          } as Row,
        ],
        rowCount: 1,
      };
    }

    if (sql.includes('from document_branch_states')) {
      return {
        rows: [
          {
            yjs_state: Buffer.from(yjsState),
            current_markdown: currentMarkdown,
            current_hash: currentHash,
            yjs_state_fingerprint: stateFingerprint,
          } as Row,
        ],
        rowCount: 1,
      };
    }

    if (sql.includes('from documents d')) {
      return {
        rows: [
          {
            doc_id: 'doc_001',
            branch_id: 'br_main',
            version_id: currentVersionId,
            version_number: currentVersionNumber,
            current_hash: currentHash,
            current_markdown: currentMarkdown,
          } as Row,
        ],
        rowCount: 1,
      };
    }

    if (sql.includes('update document_branch_states')) {
      if (params?.[2] instanceof Buffer) {
        yjsState = new Uint8Array(params[2]);
        stateFingerprint = String(params[3]);
        currentMarkdown = String(params[4]);
        currentHash = String(params[5]);
      } else {
        currentMarkdown = String(params?.[1]);
        currentHash = String(params?.[2]);
        yjsState = params?.[3] instanceof Buffer ? new Uint8Array(params[3]) : yjsState;
        stateFingerprint = String(params?.[4] ?? stateFingerprint);
      }
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes('coalesce(max(version_number)')) {
      return { rows: [{ next_version_number: nextVersionNumber++ } as Row], rowCount: 1 };
    }

    if (sql.includes('from document_branch_autosave_state')) {
      return {
        rows: [{
          pending_hash: options.pendingAutosaveHash ?? null,
          active_started_at: options.activeAutosaveStartedAt ?? null,
          pending_first_seen_at: options.pendingAutosaveFirstSeenAt ?? null,
        } as Row],
        rowCount: 1,
      };
    }

    if (sql.includes('select max(created_at) as last_autosave_at')) {
      return { rows: [{ last_autosave_at: options.lastAutosaveAt ?? null } as Row], rowCount: 1 };
    }

    if (sql.includes('insert into document_versions')) {
      const id = versionIds.shift() ?? 'ver_next';
      pendingVersion = {
        id,
        versionNumber: Number(params?.[3] ?? currentVersionNumber + 1),
        markdown: String(params?.[4] ?? currentMarkdown),
        hash: String(params?.[5] ?? currentHash),
      };
      return { rows: [{ id } as Row], rowCount: 1 };
    }

    if (sql.includes('update document_branches') && pendingVersion && params?.[1] === pendingVersion.id) {
      currentVersionId = pendingVersion.id;
      currentVersionNumber = pendingVersion.versionNumber;
      currentMarkdown = pendingVersion.markdown;
      currentHash = pendingVersion.hash;
      headHash = pendingVersion.hash;
      pendingVersion = undefined;
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes('insert into document_branch_autosave_state')) {
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes('delete from document_branch_autosave_state')) {
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes('select max(created_at) as branch_edit_clock')) {
      return { rows: [{ branch_edit_clock: new Date() } as Row], rowCount: 1 };
    }

    if (sql.includes('select id') && sql.includes('operation = \'autosave\'') && sql.includes('created_at <')) {
      return { rows: [], rowCount: 0 };
    }

    return { rows: [], rowCount: 1 };
  };

  const client: DbTransactionClient = {
    query,
    release: () => undefined,
  };

  const pool: DbPool = {
    query,
    connect: async () => client,
  };

  return { pool, queries };
}

async function updateFakePoolFromMarkdown(
  fakePool: ReturnType<typeof createFakePool>,
  markdown: string,
  hash: string,
  yjsState: Uint8Array,
) {
  await fakePool.pool.query('update document_branch_states', [
    'br_main',
    markdown,
    hash,
    Buffer.from(yjsState),
    'active-flush-fingerprint',
  ]);
}

function createRecordingLiveWriter(
  result: Pick<AppliedLiveMarkdownTransaction, 'serializedMarkdown' | 'yjsState'> &
    Partial<Omit<AppliedLiveMarkdownTransaction, 'serializedMarkdown' | 'yjsState'>>,
): LiveMarkdownWriter & { transactions: LiveMarkdownTransaction[] } {
  const transactions: LiveMarkdownTransaction[] = [];
  return {
    transactions,
    async applyMarkdownTransaction(transaction) {
      transactions.push(transaction);
      return {
        changedRangeCount: 1,
        changedCharacterCount: result.serializedMarkdown.length,
        documentCharacterCount: result.serializedMarkdown.length,
        fullDocumentReplacement: true,
        appliedTransactionCount: 1,
        ...result,
      };
    },
  };
}

function hasMirrorOrVersionWrite(queries: CapturedQuery[]): boolean {
  return queries.some(
    (query) =>
      query.sql.includes('update document_branch_states') || query.sql.includes('insert into document_versions'),
  );
}

function createValidYjsState(): Uint8Array {
  const doc = new Y.Doc();
  doc.getText('prosemirror').insert(0, 'live state');
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

function requestToken(req: Parameters<HttpRequestAuth['requireDocumentAccess']>[0]): string | undefined {
  const queryToken = req.query.token;
  if (typeof queryToken === 'string' && queryToken) return queryToken;
  const match = /^Bearer\s+(.+)$/iu.exec(req.header('authorization') ?? '');
  return match?.[1];
}

function createRequiredAuth(pool: DbPool): HttpRequestAuth {
  return {
    async requireAdminAccess(req) {
      verifyAdminToken(requestToken(req), sha256Hex('admin-secret'));
    },
    async requireDocumentAccess(req, docId, branchId, operation) {
      await verifyDocumentAccess(pool, requestToken(req), docId, branchId, operation);
    },
  };
}

describe('doc AI routes minimal transaction e2e', () => {
  it('flushes an active collab document before read_doc reads branch state', async () => {
    const runtime = createHeadlessMilkdownRuntime();
    const stale = await runtime.initializeFromMarkdown('# Stale mirror\n');
    const active = await runtime.initializeFromMarkdown('# Active edit\n');
    const fakePool = createFakePool({
      currentMarkdown: stale.markdown,
      currentHash: stale.hash,
      currentVersionId: 'ver_001',
      currentVersionNumber: 1,
      headHash: stale.hash,
      yjsState: stale.yjsState,
      versionIds: ['ver_002'],
    });
    const flushedRooms: string[] = [];
    const app = createDocAiTestApp(fakePool.pool, createPostgresLiveMarkdownWriter(fakePool.pool), {
      async flushCollabDocument(roomName) {
        flushedRooms.push(roomName);
        await updateFakePoolFromMarkdown(fakePool, active.markdown, active.hash, active.yjsState);
      },
    });

    const response = await request(app).get('/api/docs/doc_001/branches/br_main/read').expect(200);

    expect(flushedRooms).toEqual([toRoomName('doc_001', 'br_main')]);
    expect(response.body.markdown).toBe(active.markdown);
    expect(response.body.hash).toBe(active.hash);
  });

  it('checks write_doc baseHash against active-flushed Yjs state instead of stale Postgres bytes', async () => {
    const runtime = createHeadlessMilkdownRuntime();
    const stale = await runtime.initializeFromMarkdown('# Stale mirror\n');
    const active = await runtime.initializeFromMarkdown('# Active edit\n');
    const fakePool = createFakePool({
      currentMarkdown: stale.markdown,
      currentHash: stale.hash,
      currentVersionId: 'ver_001',
      currentVersionNumber: 1,
      headHash: stale.hash,
      yjsState: stale.yjsState,
      versionIds: ['ver_002', 'ver_003'],
    });
    const app = createDocAiTestApp(fakePool.pool, createPostgresLiveMarkdownWriter(fakePool.pool), {
      async flushCollabDocument(roomName) {
        expect(roomName).toBe(toRoomName('doc_001', 'br_main'));
        await updateFakePoolFromMarkdown(fakePool, active.markdown, active.hash, active.yjsState);
      },
    });

    const response = await request(app)
      .post('/api/docs/doc_001/branches/br_main/write')
      .send({ baseVersionId: 'ver_001', baseHash: stale.hash, markdown: '# Agent write\n' })
      .expect(409);

    expect(response.body).toEqual({ error: 'live_yjs_state_changed' });
  });

  it('applies edit_doc against active-flushed Yjs state instead of stale Postgres bytes', async () => {
    const runtime = createHeadlessMilkdownRuntime();
    const stale = await runtime.initializeFromMarkdown('# Stale mirror\n');
    const active = await runtime.initializeFromMarkdown('# Active edit\n');
    const fakePool = createFakePool({
      currentMarkdown: stale.markdown,
      currentHash: stale.hash,
      currentVersionId: 'ver_001',
      currentVersionNumber: 1,
      headHash: stale.hash,
      yjsState: stale.yjsState,
      versionIds: ['ver_002', 'ver_003'],
    });
    const app = createDocAiTestApp(fakePool.pool, createPostgresLiveMarkdownWriter(fakePool.pool), {
      async flushCollabDocument(roomName) {
        expect(roomName).toBe(toRoomName('doc_001', 'br_main'));
        await updateFakePoolFromMarkdown(fakePool, active.markdown, active.hash, active.yjsState);
      },
    });

    const response = await request(app)
      .post('/api/docs/doc_001/branches/br_main/edit')
      .send({ oldString: 'Active', newString: 'Agent', replaceAll: false })
      .expect(200);

    const expectedAgentMarkdown = await canonicalizeMarkdown('# Agent edit\n');
    const expectedAgentHash = sha256Hex(expectedAgentMarkdown);

    expect(response.body).toEqual({ versionId: 'ver_003', versionNumber: 3, hash: expectedAgentHash });
  });

  it('flushes live state and creates an autosave version before read_doc returns version and hash', async () => {
    const runtime = createHeadlessMilkdownRuntime();
    const seeded = await runtime.initializeFromMarkdown('# Human live edit\n');
    const { pool, queries } = createFakePool({
      currentMarkdown: seeded.markdown,
      currentHash: seeded.hash,
      currentVersionId: 'ver_001',
      currentVersionNumber: 1,
      headHash: 'sha256:old',
      yjsState: seeded.yjsState,
      pendingAutosaveHash: seeded.hash,
      activeAutosaveStartedAt: new Date('2026-05-22T12:00:00Z'),
      pendingAutosaveFirstSeenAt: new Date(Date.now() - 3 * 60 * 1000),
      versionIds: ['ver_002'],
    });
    const operations: string[] = [];
    const app = createDocAiTestApp(pool, createPostgresLiveMarkdownWriter(pool), {
      auth: {
        async requireAdminAccess() {},
        async requireDocumentAccess(_req, docId, branchId, operation) {
          expect({ docId, branchId }).toEqual({ docId: 'doc_001', branchId: 'br_main' });
          operations.push(operation);
          return { actorType: 'user', actorId: 'user_reader' };
        },
      },
    });

    const response = await request(app).get('/api/docs/doc_001/branches/br_main/read').expect(200);

    expect(response.body.versionId).toBe('ver_002');
    expect(response.body.versionNumber).toBe(2);
    expect(response.body.hash).toBe(seeded.hash);
    expect(response.body.markdown).toBe(seeded.markdown);
    expect(operations).toEqual(['read', 'write']);
    const versionInsert = queries.find((query) => query.sql.includes('insert into document_versions'));
    expect(versionInsert?.params).toEqual([
      'doc_001',
      'br_main',
      'ver_001',
      2,
      seeded.markdown,
      seeded.hash,
      'user',
      'user_reader',
      'autosave',
    ]);
  });

  it('does not create an autosave version for read-only read_doc access', async () => {
    const runtime = createHeadlessMilkdownRuntime();
    const seeded = await runtime.initializeFromMarkdown('# Reader live view\n');
    const { pool, queries } = createFakePool({
      currentMarkdown: seeded.markdown,
      currentHash: seeded.hash,
      currentVersionId: 'ver_001',
      currentVersionNumber: 1,
      headHash: 'sha256:old',
      yjsState: seeded.yjsState,
      versionIds: ['ver_002'],
    });
    const operations: string[] = [];
    const app = createDocAiTestApp(pool, createPostgresLiveMarkdownWriter(pool), {
      auth: {
        async requireAdminAccess() {},
        async requireDocumentAccess(_req, docId, branchId, operation) {
          expect({ docId, branchId }).toEqual({ docId: 'doc_001', branchId: 'br_main' });
          operations.push(operation);
          if (operation === 'write') throw new Error('forbidden');
          return { actorType: 'user', actorId: 'user_reader' };
        },
      },
    });

    const response = await request(app).get('/api/docs/doc_001/branches/br_main/read').expect(200);

    expect(response.body.versionId).toBe('ver_001');
    expect(response.body.versionNumber).toBe(1);
    expect(response.body.hash).toBe(seeded.hash);
    expect(response.body.markdown).toBe(seeded.markdown);
    expect(operations).toEqual(['read', 'write']);
    expect(queries.some((query) => query.sql.includes('insert into document_versions'))).toBe(false);
  });

  it('persists the live transaction serialization rather than the requested full-write markdown', async () => {
    const { pool, queries } = createFakePool();
    const liveSerializedMarkdown = '## Live serialized\n\n|A|B|\n|-|-|\n|1|2|\n';
    const liveYjsState = createValidYjsState();
    const liveWriter = createRecordingLiveWriter({
      serializedMarkdown: liveSerializedMarkdown,
      yjsState: liveYjsState,
      previousHash: 'sha256:current',
      changedRangeCount: 1,
      appliedTransactionCount: 1,
    });
    const appliedRooms: Array<{ roomName: string; yjsState: Uint8Array }> = [];
    const app = createDocAiTestApp(pool, liveWriter, {
      async applyCollabDocumentState(roomName, yjsState) {
        appliedRooms.push({ roomName, yjsState });
      },
    });

    const response = await request(app)
      .post('/api/docs/doc_001/branches/br_main/write')
      .send({ baseVersionId: 'ver_001', baseHash: 'sha256:current', markdown: '# Requested target' })
      .expect(200);

    const expectedMarkdown = await canonicalizeMarkdown(liveSerializedMarkdown);
    const expectedHash = sha256Hex(expectedMarkdown);

    expect(liveWriter.transactions).toEqual([
      {
        branchId: 'br_main',
        targetCanonicalMarkdown: '# Requested target\n',
        operation: { kind: 'write', baseVersionId: 'ver_001', baseHash: 'sha256:current' },
      },
    ]);
    expect(response.body).toEqual({ versionId: 'ver_002', versionNumber: 2, hash: expectedHash });
    expect(appliedRooms).toEqual([{ roomName: toRoomName('doc_001', 'br_main'), yjsState: liveYjsState }]);

    const mirrorUpdate = queries.find((query) => query.sql.includes('update document_branch_states'));
    expect(mirrorUpdate?.params).toEqual([
      'br_main',
      expectedMarkdown,
      expectedHash,
      Buffer.from(liveYjsState),
      expect.any(String),
    ]);

    const versionInsert = queries.find((query) => query.sql.includes('insert into document_versions'));
    expect(versionInsert?.params).toEqual([
      'doc_001',
      'br_main',
      'ver_001',
      2,
      expectedMarkdown,
      expectedHash,
      'user',
      null,
      'write',
    ]);
  });

  it('rejects stale full writes before calling the live transaction writer', async () => {
    const { pool, queries } = createFakePool({ currentVersionId: 'ver_002' });
    const liveWriter = createRecordingLiveWriter({
      serializedMarkdown: '# Should not be used\n',
      yjsState: createValidYjsState(),
      changedRangeCount: 1,
      appliedTransactionCount: 1,
    });
    const app = createDocAiTestApp(pool, liveWriter, {
      auth: {
        async requireAdminAccess() {},
        async requireDocumentAccess(_req, docId, branchId, operation) {
          expect({ docId, branchId, operation }).toEqual({
            docId: 'doc_001',
            branchId: 'br_main',
            operation: 'write',
          });
          return { actorType: 'user', actorId: 'user_member' };
        },
      },
    });

    const response = await request(app)
      .post('/api/docs/doc_001/branches/br_main/write')
      .send({ baseVersionId: 'ver_001', baseHash: 'sha256:current', markdown: '# Requested target' })
      .expect(409);

    expect(response.body).toEqual({
      error: 'stale_base_version',
      currentVersionId: 'ver_002',
      currentHash: 'sha256:current',
    });
    expect(liveWriter.transactions).toEqual([]);
    expect(hasMirrorOrVersionWrite(queries)).toBe(false);
  });

  it('accepts a checkpointed full write only when the live hash matches the submitted base hash', async () => {
    const { pool, queries } = createFakePool({
      currentMarkdown: '# Human draft\n',
      currentHash: 'sha256:dirty',
      currentVersionId: 'ver_010',
      currentVersionNumber: 10,
      headHash: 'sha256:head',
      versionIds: ['ver_011', 'ver_012'],
    });
    const liveWriter = createRecordingLiveWriter({
      serializedMarkdown: '# Agent result\n',
      yjsState: createValidYjsState(),
      previousSerializedMarkdown: '# Human draft\n',
      previousHash: 'sha256:dirty',
      changedRangeCount: 1,
      appliedTransactionCount: 1,
    });
    const app = createDocAiTestApp(pool, liveWriter, {
      auth: {
        async requireAdminAccess() {},
        async requireDocumentAccess(_req, docId, branchId, operation) {
          expect({ docId, branchId, operation }).toEqual({
            docId: 'doc_001',
            branchId: 'br_main',
            operation: 'write',
          });
          return { actorType: 'user', actorId: 'user_member' };
        },
      },
    });

    const response = await request(app)
      .post('/api/docs/doc_001/branches/br_main/write')
      .send({ baseVersionId: 'ver_010', baseHash: 'sha256:dirty', markdown: '# Agent target' })
      .expect(200);

    const expectedMarkdown = await canonicalizeMarkdown('# Agent result\n');
    const expectedHash = sha256Hex(expectedMarkdown);
    const versionInserts = queries.filter((query) => query.sql.includes('insert into document_versions'));

    expect(response.body).toEqual({ versionId: 'ver_012', versionNumber: 12, hash: expectedHash });
    expect(versionInserts.map((query) => query.params)).toEqual([
      ['doc_001', 'br_main', 'ver_010', 11, '# Human draft\n', 'sha256:dirty', 'user', 'user_member', 'autosave'],
      ['doc_001', 'br_main', 'ver_011', 12, expectedMarkdown, expectedHash, 'user', 'user_member', 'write'],
    ]);
  });

  it('rejects write_doc based on a stale mirror when freshly serialized live Yjs has changed', async () => {
    const runtime = createHeadlessMilkdownRuntime();
    const mirror = await runtime.initializeFromMarkdown('# Mirror A\n');
    const live = await runtime.initializeFromMarkdown('# Live B\n');
    const { pool, queries } = createFakePool({
      currentMarkdown: mirror.markdown,
      currentHash: mirror.hash,
      currentVersionId: 'ver_001',
      currentVersionNumber: 1,
      headHash: mirror.hash,
      yjsState: live.yjsState,
      versionIds: ['ver_002', 'ver_003'],
    });
    const app = createDocAiTestApp(pool, createPostgresLiveMarkdownWriter(pool), {
      auth: {
        async requireAdminAccess() {},
        async requireDocumentAccess(_req, docId, branchId, operation) {
          expect({ docId, branchId, operation }).toEqual({
            docId: 'doc_001',
            branchId: 'br_main',
            operation: 'write',
          });
          return { actorType: 'agent', actorId: 'agent:edit-token' };
        },
      },
    });

    const response = await request(app)
      .post('/api/docs/doc_001/branches/br_main/write')
      .send({ baseVersionId: 'ver_001', baseHash: mirror.hash, markdown: '# Agent C\n' })
      .expect(409);

    expect(response.body).toEqual({ error: 'live_yjs_state_changed' });
    expect(hasMirrorOrVersionWrite(queries)).toBe(false);
  });

  it('applies edits against flushed live Yjs markdown instead of the stale mirror', async () => {
    const runtime = createHeadlessMilkdownRuntime();
    const mirror = await runtime.initializeFromMarkdown('# Mirror A\n');
    const live = await runtime.initializeFromMarkdown('# Live B\n');
    const { pool, queries } = createFakePool({
      currentMarkdown: mirror.markdown,
      currentHash: mirror.hash,
      currentVersionId: 'ver_001',
      currentVersionNumber: 1,
      headHash: mirror.hash,
      yjsState: live.yjsState,
      versionIds: ['ver_002', 'ver_003'],
    });
    const app = createDocAiTestApp(pool, createPostgresLiveMarkdownWriter(pool), {
      auth: {
        async requireAdminAccess() {},
        async requireDocumentAccess(_req, docId, branchId, operation) {
          expect({ docId, branchId, operation }).toEqual({
            docId: 'doc_001',
            branchId: 'br_main',
            operation: 'write',
          });
          return { actorType: 'agent', actorId: 'agent:edit-token' };
        },
      },
    });

    const response = await request(app)
      .post('/api/docs/doc_001/branches/br_main/edit')
      .send({ oldString: 'Live', newString: 'Agent', replaceAll: false })
      .expect(200);

    const expectedAgentMarkdown = await canonicalizeMarkdown('# Agent B\n');
    const expectedAgentHash = sha256Hex(expectedAgentMarkdown);
    const versionInserts = queries.filter((query) => query.sql.includes('insert into document_versions'));

    expect(response.body).toEqual({ versionId: 'ver_003', versionNumber: 3, hash: expectedAgentHash });
    expect(versionInserts.map((query) => query.params)).toEqual([
      ['doc_001', 'br_main', 'ver_001', 2, live.markdown, live.hash, 'agent', 'agent:edit-token', 'autosave'],
      ['doc_001', 'br_main', 'ver_002', 3, expectedAgentMarkdown, expectedAgentHash, 'agent', 'agent:edit-token', 'edit'],
    ]);
  });

  it('returns a retryable conflict when live freshness contention exhausts retries', async () => {
    const { pool, queries } = createFakePool();
    const liveWriter = createRecordingLiveWriter({
      serializedMarkdown: '# Agent result\n',
      yjsState: createValidYjsState(),
      sourceStateFingerprint: 'stale-state',
      changedRangeCount: 1,
      appliedTransactionCount: 1,
    });
    const app = createDocAiTestApp(pool, liveWriter, {
      auth: {
        async requireAdminAccess() {},
        async requireDocumentAccess(_req, docId, branchId, operation) {
          expect({ docId, branchId, operation }).toEqual({
            docId: 'doc_001',
            branchId: 'br_main',
            operation: 'write',
          });
          return { actorType: 'user', actorId: 'user_editor' };
        },
      },
    });

    const response = await request(app)
      .post('/api/docs/doc_001/branches/br_main/write')
      .send({ baseVersionId: 'ver_001', baseHash: 'sha256:current', markdown: '# Requested target' })
      .expect(409);

    expect(response.body).toEqual({ error: 'live_yjs_state_changed' });
    expect(liveWriter.transactions).toHaveLength(3);
    expect(hasMirrorOrVersionWrite(queries)).toBe(false);
  });

  it('fails closed without mirror or version writes when the live writer is not configured', async () => {
    const { pool, queries } = createFakePool();
    const app = createDocAiTestApp(pool, createUnavailableLiveMarkdownWriter());

    const response = await request(app)
      .post('/api/docs/doc_001/branches/br_main/write')
      .send({ baseVersionId: 'ver_001', baseHash: 'sha256:current', markdown: '# Requested target' })
      .expect(503);

    expect(response.body).toEqual({ error: 'live_writer_not_configured' });
    expect(hasMirrorOrVersionWrite(queries)).toBe(false);
  });

  it('fails closed for write_doc when the live writer omits the fresh live base hash', async () => {
    const { pool, queries } = createFakePool();
    const liveWriter = createRecordingLiveWriter({
      serializedMarkdown: '# Agent result\n',
      yjsState: createValidYjsState(),
      changedRangeCount: 1,
      appliedTransactionCount: 1,
    });
    const app = createDocAiTestApp(pool, liveWriter);

    const response = await request(app)
      .post('/api/docs/doc_001/branches/br_main/write')
      .send({ baseVersionId: 'ver_001', baseHash: 'sha256:current', markdown: '# Requested target' })
      .expect(503);

    expect(response.body).toEqual({ error: 'live_writer_missing_previous_hash' });
    expect(hasMirrorOrVersionWrite(queries)).toBe(false);
  });

  it('fails closed on edit without flushing dirty live state when the live writer is not configured', async () => {
    const { pool, queries } = createFakePool({
      currentMarkdown: '# Human draft\n',
      currentHash: 'sha256:dirty',
      headHash: 'sha256:head',
    });
    const app = createDocAiTestApp(pool, createUnavailableLiveMarkdownWriter());

    const response = await request(app)
      .post('/api/docs/doc_001/branches/br_main/edit')
      .send({ oldString: 'Human', newString: 'Agent', replaceAll: false })
      .expect(503);

    expect(response.body).toEqual({ error: 'live_writer_not_configured' });
    expect(hasMirrorOrVersionWrite(queries)).toBe(false);
  });

  it('fails closed without mirror or version writes when the live writer returns an empty yjs state', async () => {
    const { pool, queries } = createFakePool();
    const liveWriter = createRecordingLiveWriter({
      serializedMarkdown: '# Live result\n',
      yjsState: new Uint8Array(),
      changedRangeCount: 1,
      appliedTransactionCount: 1,
    });
    const app = createDocAiTestApp(pool, liveWriter);

    const response = await request(app)
      .post('/api/docs/doc_001/branches/br_main/write')
      .send({ baseVersionId: 'ver_001', baseHash: 'sha256:current', markdown: '# Requested target' })
      .expect(503);

    expect(response.body).toEqual({ error: 'invalid_live_yjs_state' });
    expect(hasMirrorOrVersionWrite(queries)).toBe(false);
  });

  it('fails closed without mirror or version writes when the live writer returns invalid yjs bytes', async () => {
    const { pool, queries } = createFakePool();
    const liveWriter = createRecordingLiveWriter({
      serializedMarkdown: '# Live result\n',
      yjsState: new Uint8Array([1, 2, 3]),
      changedRangeCount: 1,
      appliedTransactionCount: 1,
    });
    const app = createDocAiTestApp(pool, liveWriter);

    const response = await request(app)
      .post('/api/docs/doc_001/branches/br_main/write')
      .send({ baseVersionId: 'ver_001', baseHash: 'sha256:current', markdown: '# Requested target' })
      .expect(503);

    expect(response.body).toEqual({ error: 'invalid_live_yjs_state' });
    expect(hasMirrorOrVersionWrite(queries)).toBe(false);
  });

  it('persists exact edit as one edit version after one live transaction', async () => {
    const runtime = createHeadlessMilkdownRuntime();
    const seeded = await runtime.initializeFromMarkdown('A old\nB old\n');
    const { pool, queries } = createFakePool({
      currentMarkdown: seeded.markdown,
      currentHash: seeded.hash,
      headHash: seeded.hash,
      yjsState: seeded.yjsState,
      currentVersionId: 'ver_current',
    });
    const liveWriter = createRecordingLiveWriter({
      serializedMarkdown: 'A new\nB old\n',
      yjsState: createValidYjsState(),
      changedRangeCount: 1,
      appliedTransactionCount: 1,
    });
    const app = createDocAiTestApp(pool, liveWriter, {
      auth: {
        async requireAdminAccess() {},
        async requireDocumentAccess(_req, docId, branchId, operation) {
          expect({ docId, branchId, operation }).toEqual({
            docId: 'doc_001',
            branchId: 'br_main',
            operation: 'write',
          });
          return { actorType: 'user', actorId: 'user_editor' };
        },
      },
    });

    const response = await request(app)
      .post('/api/docs/doc_001/branches/br_main/edit')
      .send({
        observedVersionId: 'ver_observed',
        oldString: 'A old',
        newString: 'A new',
        replaceAll: false,
      })
      .expect(200);

    const expectedMarkdown = await canonicalizeMarkdown('A new\nB old\n');
    const expectedHash = sha256Hex(expectedMarkdown);

    expect(liveWriter.transactions).toEqual([
      {
        branchId: 'br_main',
        targetCanonicalMarkdown: 'A new\nB old\n',
        operation: {
          kind: 'edit',
          observedVersionId: 'ver_observed',
          oldString: 'A old',
          newString: 'A new',
          replaceAll: false,
        },
      },
    ]);
    expect(response.body).toEqual({ versionId: 'ver_002', versionNumber: 2, hash: expectedHash });

    const versionInsert = queries.find((query) => query.sql.includes('insert into document_versions'));
    expect(versionInsert?.params).toEqual([
      'doc_001',
      'br_main',
      'ver_current',
      2,
      expectedMarkdown,
      expectedHash,
      'user',
      'user_editor',
      'edit',
    ]);
  });

  it('rejects read_doc without a document token when auth is required', async () => {
    const { pool } = createFakePool();
    const app = createDocAiTestApp(pool, createUnavailableLiveMarkdownWriter(), { auth: createRequiredAuth(pool) });

    await request(app).get('/api/docs/doc_001/branches/br_main/read').expect(403, { error: 'forbidden' });
  });

  it('rejects write_doc with a read-only share link when auth is required', async () => {
    const shareToken = 'ml_share_readonly';
    const { pool, queries } = createFakePool({
      shareLinks: [
        {
          tokenHash: sha256Hex(shareToken),
          docId: 'doc_001',
          branchId: 'br_main',
          role: 'view',
        },
      ],
    });
    const app = createDocAiTestApp(pool, createUnavailableLiveMarkdownWriter(), { auth: createRequiredAuth(pool) });

    await request(app)
      .post('/api/docs/doc_001/branches/br_main/write')
      .set('Authorization', `Bearer ${shareToken}`)
      .send({ baseVersionId: 'ver_001', baseHash: 'sha256:current', markdown: '# Requested target' })
      .expect(403, { error: 'forbidden' });

    expect(hasMirrorOrVersionWrite(queries)).toBe(false);
  });

  it('uses ml_access view grants only for read_doc on the shared branch', async () => {
    const accessToken = 'ml_access_view';
    const runtime = createHeadlessMilkdownRuntime();
    const seeded = await runtime.initializeFromMarkdown('# Doc\n\nOld paragraph.\n');
    const { pool, queries } = createFakePool({
      currentMarkdown: seeded.markdown,
      currentHash: seeded.hash,
      headHash: seeded.hash,
      yjsState: seeded.yjsState,
      accessGrants: [
        {
          tokenHash: sha256Hex(accessToken),
          docId: 'doc_001',
          branchId: 'br_main',
          role: 'view',
        },
      ],
    });
    const app = createDocAiTestApp(pool, createUnavailableLiveMarkdownWriter(), { auth: createRequiredAuth(pool) });

    await request(app)
      .get('/api/docs/doc_001/branches/br_main/read')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    await request(app)
      .get('/api/docs/doc_001/branches/br_other/read')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(403, { error: 'forbidden' });

    await request(app)
      .get('/api/docs/doc_other/branches/br_main/read')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(403, { error: 'forbidden' });

    const writesBeforeForbiddenWrite = queries.filter(
      (query) => query.sql.includes('update document_branch_states') || query.sql.includes('insert into document_versions'),
    ).length;

    await request(app)
      .post('/api/docs/doc_001/branches/br_main/write')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ baseVersionId: 'ver_001', baseHash: 'sha256:current', markdown: '# Requested target' })
      .expect(403, { error: 'forbidden' });

    expect(
      queries.filter(
        (query) => query.sql.includes('update document_branch_states') || query.sql.includes('insert into document_versions'),
      ),
    ).toHaveLength(writesBeforeForbiddenWrite);
  });

  it('uses ml_access edit grants only for write_doc and edit_doc on the shared branch', async () => {
    const accessToken = 'ml_access_edit';
    const { pool } = createFakePool({
      accessGrants: [
        {
          tokenHash: sha256Hex(accessToken),
          docId: 'doc_001',
          branchId: 'br_main',
          role: 'edit',
        },
      ],
      versionIds: ['ver_002', 'ver_003'],
    });
    const liveWriter = createRecordingLiveWriter({
      serializedMarkdown: '# Agent result\n',
      yjsState: createValidYjsState(),
      previousHash: 'sha256:current',
      changedRangeCount: 1,
      appliedTransactionCount: 1,
    });
    const app = createDocAiTestApp(pool, liveWriter, { auth: createRequiredAuth(pool) });

    await request(app)
      .post('/api/docs/doc_001/branches/br_main/write')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ baseVersionId: 'ver_001', baseHash: 'sha256:current', markdown: '# Agent target' })
      .expect(200);

    await request(app)
      .post('/api/docs/doc_001/branches/br_other/edit')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ oldString: 'Old', newString: 'New', replaceAll: false })
      .expect(403, { error: 'forbidden' });
  });

  it('allows write_doc with a write-capable agent token when auth is required', async () => {
    const agentToken = 'ml_agent_write';
    const { pool } = createFakePool({
      agentTokens: [
        {
          tokenHash: sha256Hex(agentToken),
          docId: 'doc_001',
          branchId: 'br_main',
          canRead: true,
          canWrite: true,
        },
      ],
    });
    const liveWriter = createRecordingLiveWriter({
      serializedMarkdown: '# Agent result\n',
      yjsState: createValidYjsState(),
      previousHash: 'sha256:current',
      changedRangeCount: 1,
      appliedTransactionCount: 1,
    });
    const app = createDocAiTestApp(pool, liveWriter, { auth: createRequiredAuth(pool) });

    await request(app)
      .post('/api/docs/doc_001/branches/br_main/write')
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ baseVersionId: 'ver_001', baseHash: 'sha256:current', markdown: '# Agent target' })
      .expect(200);
  });

  it('requires the admin token for create and import when auth is required', async () => {
    const { pool } = createFakePool();
    const app = createDocAiTestApp(pool, createUnavailableLiveMarkdownWriter(), { auth: createRequiredAuth(pool) });

    await request(app).post('/api/docs').send({ title: 'Locked' }).expect(403, { error: 'forbidden' });
    await request(app)
      .post('/api/docs/import')
      .send({ title: 'Locked import', markdown: '# Locked\n' })
      .expect(403, { error: 'forbidden' });
  });
});
