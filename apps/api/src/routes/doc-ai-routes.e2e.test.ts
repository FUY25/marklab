import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { canonicalizeMarkdown } from '@marklab/markdown/src/canonicalize';
import { sha256Hex } from '@marklab/shared/src/hash';
import * as Y from 'yjs';
import type { DbPool, DbQueryResult, DbTransactionClient } from '../db/client';
import { createHttpApp } from '../http/app';
import { createHeadlessMilkdownRuntime } from '../services/milkdown-headless-runtime';
import type { AppliedLiveMarkdownTransaction, LiveMarkdownTransaction, LiveMarkdownWriter } from '../services/live-writer';
import { createUnavailableLiveMarkdownWriter } from '../services/live-writer';
import { createPostgresLiveMarkdownWriter } from '../services/postgres-live-writer';

interface FakePoolOptions {
  currentMarkdown?: string;
  currentHash?: string;
  currentVersionId?: string;
  currentVersionNumber?: number;
  headHash?: string;
  versionIds?: string[];
  yjsState?: Uint8Array;
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

describe('doc AI routes minimal transaction e2e', () => {
  it('flushes live state and creates an autosave version before read_doc returns version and hash', async () => {
    const runtime = createHeadlessMilkdownRuntime();
    const seeded = await runtime.initializeFromMarkdown('# Human live edit\n');
    const { pool } = createFakePool({
      currentMarkdown: seeded.markdown,
      currentHash: seeded.hash,
      currentVersionId: 'ver_001',
      currentVersionNumber: 1,
      headHash: 'sha256:old',
      yjsState: seeded.yjsState,
      versionIds: ['ver_002'],
    });
    const app = createHttpApp(pool, createPostgresLiveMarkdownWriter(pool));

    const response = await request(app).get('/api/docs/doc_001/branches/br_main/read').expect(200);

    expect(response.body.versionId).toBe('ver_002');
    expect(response.body.versionNumber).toBe(2);
    expect(response.body.hash).toBe(seeded.hash);
    expect(response.body.markdown).toBe(seeded.markdown);
  });

  it('persists the live transaction serialization rather than the requested full-write markdown', async () => {
    const { pool, queries } = createFakePool();
    const liveSerializedMarkdown = '## Live serialized\n\n|A|B|\n|-|-|\n|1|2|\n';
    const liveYjsState = createValidYjsState();
    const liveWriter = createRecordingLiveWriter({
      serializedMarkdown: liveSerializedMarkdown,
      yjsState: liveYjsState,
      changedRangeCount: 1,
      appliedTransactionCount: 1,
    });
    const app = createHttpApp(pool, liveWriter);

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
      'agent',
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
    const app = createHttpApp(pool, liveWriter);

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

  it('checks write guards before creating a dirty-branch checkpoint and agent child version', async () => {
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
      changedRangeCount: 1,
      appliedTransactionCount: 1,
    });
    const app = createHttpApp(pool, liveWriter);

    const response = await request(app)
      .post('/api/docs/doc_001/branches/br_main/write')
      .send({ baseVersionId: 'ver_010', baseHash: 'sha256:dirty', markdown: '# Agent target' })
      .expect(200);

    const expectedMarkdown = await canonicalizeMarkdown('# Agent result\n');
    const expectedHash = sha256Hex(expectedMarkdown);
    const versionInserts = queries.filter((query) => query.sql.includes('insert into document_versions'));

    expect(response.body).toEqual({ versionId: 'ver_012', versionNumber: 12, hash: expectedHash });
    expect(versionInserts.map((query) => query.params)).toEqual([
      ['doc_001', 'br_main', 'ver_010', 11, '# Human draft\n', 'sha256:dirty', 'system', null, 'autosave'],
      ['doc_001', 'br_main', 'ver_011', 12, expectedMarkdown, expectedHash, 'agent', null, 'write'],
    ]);
  });

  it('flushes uncheckpointed live Yjs edits into an autosave before accepting a write based on the mirror', async () => {
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
    const app = createHttpApp(pool, createPostgresLiveMarkdownWriter(pool));

    const response = await request(app)
      .post('/api/docs/doc_001/branches/br_main/write')
      .send({ baseVersionId: 'ver_001', baseHash: mirror.hash, markdown: '# Agent C\n' })
      .expect(200);

    const expectedAgentMarkdown = await canonicalizeMarkdown('# Agent C\n');
    const expectedAgentHash = sha256Hex(expectedAgentMarkdown);
    const versionInserts = queries.filter((query) => query.sql.includes('insert into document_versions'));

    expect(response.body).toEqual({ versionId: 'ver_003', versionNumber: 3, hash: expectedAgentHash });
    expect(versionInserts.map((query) => query.params)).toEqual([
      ['doc_001', 'br_main', 'ver_001', 2, live.markdown, live.hash, 'system', null, 'autosave'],
      ['doc_001', 'br_main', 'ver_002', 3, expectedAgentMarkdown, expectedAgentHash, 'agent', null, 'write'],
    ]);
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
    const app = createHttpApp(pool, createPostgresLiveMarkdownWriter(pool));

    const response = await request(app)
      .post('/api/docs/doc_001/branches/br_main/edit')
      .send({ oldString: 'Live', newString: 'Agent', replaceAll: false })
      .expect(200);

    const expectedAgentMarkdown = await canonicalizeMarkdown('# Agent B\n');
    const expectedAgentHash = sha256Hex(expectedAgentMarkdown);
    const versionInserts = queries.filter((query) => query.sql.includes('insert into document_versions'));

    expect(response.body).toEqual({ versionId: 'ver_003', versionNumber: 3, hash: expectedAgentHash });
    expect(versionInserts.map((query) => query.params)).toEqual([
      ['doc_001', 'br_main', 'ver_001', 2, live.markdown, live.hash, 'system', null, 'autosave'],
      ['doc_001', 'br_main', 'ver_002', 3, expectedAgentMarkdown, expectedAgentHash, 'agent', null, 'edit'],
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
    const app = createHttpApp(pool, liveWriter);

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
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter());

    const response = await request(app)
      .post('/api/docs/doc_001/branches/br_main/write')
      .send({ baseVersionId: 'ver_001', baseHash: 'sha256:current', markdown: '# Requested target' })
      .expect(503);

    expect(response.body).toEqual({ error: 'live_writer_not_configured' });
    expect(hasMirrorOrVersionWrite(queries)).toBe(false);
  });

  it('fails closed on edit without flushing dirty live state when the live writer is not configured', async () => {
    const { pool, queries } = createFakePool({
      currentMarkdown: '# Human draft\n',
      currentHash: 'sha256:dirty',
      headHash: 'sha256:head',
    });
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter());

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
    const app = createHttpApp(pool, liveWriter);

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
    const app = createHttpApp(pool, liveWriter);

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
    const app = createHttpApp(pool, liveWriter);

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
      'agent',
      null,
      'edit',
    ]);
  });
});
