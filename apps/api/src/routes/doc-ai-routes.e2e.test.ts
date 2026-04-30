import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { canonicalizeMarkdown } from '@marklab/markdown/src/canonicalize';
import { sha256Hex } from '@marklab/shared/src/hash';
import type { DbPool, DbQueryResult, DbTransactionClient } from '../db/client';
import { createHttpApp } from '../http/app';
import type { AppliedLiveMarkdownTransaction, LiveMarkdownTransaction, LiveMarkdownWriter } from '../services/live-writer';
import { createUnavailableLiveMarkdownWriter } from '../services/live-writer';

interface FakePoolOptions {
  currentMarkdown?: string;
  currentHash?: string;
  currentVersionId?: string;
  currentVersionNumber?: number;
}

interface CapturedQuery {
  sql: string;
  params?: readonly unknown[];
}

function createFakePool(options: FakePoolOptions = {}) {
  const queries: CapturedQuery[] = [];
  const currentMarkdown = options.currentMarkdown ?? '# Doc\n\nOld paragraph.\n';
  const currentHash = options.currentHash ?? 'sha256:current';
  const currentVersionId = options.currentVersionId ?? 'ver_001';
  const currentVersionNumber = options.currentVersionNumber ?? 1;

  const query: DbPool['query'] = async <Row = unknown>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<DbQueryResult<Row>> => {
    queries.push(params === undefined ? { sql } : { sql, params });

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

    if (sql.includes('coalesce(max(version_number)')) {
      return { rows: [{ next_version_number: currentVersionNumber + 1 } as Row], rowCount: 1 };
    }

    if (sql.includes('insert into document_versions')) {
      return { rows: [{ id: 'ver_002' } as Row], rowCount: 1 };
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
  result: AppliedLiveMarkdownTransaction,
): LiveMarkdownWriter & { transactions: LiveMarkdownTransaction[] } {
  const transactions: LiveMarkdownTransaction[] = [];
  return {
    transactions,
    async applyMarkdownTransaction(transaction) {
      transactions.push(transaction);
      return result;
    },
  };
}

function hasMirrorOrVersionWrite(queries: CapturedQuery[]): boolean {
  return queries.some(
    (query) =>
      query.sql.includes('update document_branch_states') || query.sql.includes('insert into document_versions'),
  );
}

describe('doc AI routes minimal transaction e2e', () => {
  it('persists the live transaction serialization rather than the requested full-write markdown', async () => {
    const { pool, queries } = createFakePool();
    const liveSerializedMarkdown = '## Live serialized\n\n|A|B|\n|-|-|\n|1|2|\n';
    const liveWriter = createRecordingLiveWriter({
      serializedMarkdown: liveSerializedMarkdown,
      yjsState: new Uint8Array([1, 2, 3]),
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
    expect(mirrorUpdate?.params).toEqual(['br_main', expectedMarkdown, expectedHash, Buffer.from([1, 2, 3])]);

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
      yjsState: new Uint8Array([1, 2, 3]),
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

  it('persists exact edit as one edit version after one live transaction', async () => {
    const { pool, queries } = createFakePool({ currentMarkdown: 'A old\nB old\n', currentVersionId: 'ver_current' });
    const liveWriter = createRecordingLiveWriter({
      serializedMarkdown: 'A new\nB old\n',
      yjsState: new Uint8Array([1, 2, 3]),
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
