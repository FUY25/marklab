import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createHttpApp } from '../http/app';
import type { DbPool, DbQueryResult, DbTransactionClient } from '../db/client';
import { createUnavailableLiveMarkdownWriter } from '../services/live-writer';
import type { LiveMarkdownTransaction, LiveMarkdownWriter } from '../services/editor-state';

interface FakePoolOptions {
  currentMarkdown?: string;
  currentHash?: string;
  currentVersionId?: string;
  currentVersionNumber?: number;
}

function createFakePool(options: FakePoolOptions = {}) {
  const queries: string[] = [];
  const currentMarkdown = options.currentMarkdown ?? '# Doc\n\nOld paragraph.\n';
  const currentHash = options.currentHash ?? 'sha256:current';
  const currentVersionId = options.currentVersionId ?? 'ver_001';
  const currentVersionNumber = options.currentVersionNumber ?? 1;

  const query: DbPool['query'] = async <Row = unknown>(sql: string): Promise<DbQueryResult<Row>> => {
    queries.push(sql);

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
      };
    }

    if (sql.includes('coalesce(max(version_number)')) {
      return { rows: [{ next_version_number: currentVersionNumber + 1 } as Row] };
    }

    if (sql.includes('insert into document_versions')) return { rows: [{ id: 'ver_002' } as Row] };
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

function createEchoLiveWriter(): LiveMarkdownWriter & { transactions: LiveMarkdownTransaction[] } {
  const transactions: LiveMarkdownTransaction[] = [];
  return {
    transactions,
    async applyMarkdownTransaction(transaction) {
      transactions.push(transaction);
      return {
        serializedMarkdown: transaction.targetCanonicalMarkdown,
        changedRangeCount: 1,
        appliedTransactionCount: 1,
      };
    },
  };
}

describe('doc AI routes', () => {
  it('reads canonical branch state', async () => {
    const { pool } = createFakePool();
    const app = createHttpApp(pool, createEchoLiveWriter());

    const response = await request(app).get('/api/docs/doc_001/branches/br_main/read').expect(200);

    expect(response.body).toMatchObject({
      docId: 'doc_001',
      branchId: 'br_main',
      versionId: 'ver_001',
      hash: 'sha256:current',
    });
  });

  it('rejects stale full writes with current version metadata', async () => {
    const { pool } = createFakePool();
    const app = createHttpApp(pool, createEchoLiveWriter());

    const response = await request(app)
      .post('/api/docs/doc_001/branches/br_main/write')
      .send({ baseVersionId: 'ver_old', baseHash: 'sha256:current', markdown: '# New\n' })
      .expect(409);

    expect(response.body).toEqual({
      error: 'stale_base_version',
      currentVersionId: 'ver_001',
      currentHash: 'sha256:current',
    });
  });

  it('applies accepted full writes through the live writer transaction before persisting a version', async () => {
    const { pool, queries } = createFakePool();
    const liveWriter = createEchoLiveWriter();
    const app = createHttpApp(pool, liveWriter);

    const response = await request(app)
      .post('/api/docs/doc_001/branches/br_main/write')
      .send({ baseVersionId: 'ver_001', baseHash: 'sha256:current', markdown: '# New\n' })
      .expect(200);

    expect(liveWriter.transactions).toEqual([
      {
        branchId: 'br_main',
        targetCanonicalMarkdown: '# New\n',
        operation: { kind: 'write', baseVersionId: 'ver_001', baseHash: 'sha256:current' },
      },
    ]);
    expect(queries.some((sql) => sql.includes('update document_branch_states'))).toBe(true);
    expect(queries.some((sql) => sql.includes('insert into document_versions'))).toBe(true);
    expect(response.body).toMatchObject({ versionId: 'ver_002', versionNumber: 2 });
    expect(response.body.hash).toMatch(/^sha256:/u);
  });

  it('returns 503 when the live writer is not configured', async () => {
    const { pool } = createFakePool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter());

    const response = await request(app)
      .post('/api/docs/doc_001/branches/br_main/write')
      .send({ baseVersionId: 'ver_001', baseHash: 'sha256:current', markdown: '# New\n' })
      .expect(503);

    expect(response.body).toEqual({ error: 'live_writer_not_configured' });
  });

  it('rejects ambiguous edit matches', async () => {
    const { pool } = createFakePool({ currentMarkdown: 'old old' });
    const app = createHttpApp(pool, createEchoLiveWriter());

    const response = await request(app)
      .post('/api/docs/doc_001/branches/br_main/edit')
      .send({ baseVersionId: 'ver_001', oldString: 'old', newString: 'new', replaceAll: false })
      .expect(409);

    expect(response.body).toEqual({ error: 'ambiguous_match', matchCount: 2 });
  });

  it('passes exact edit operation metadata to the live writer transaction', async () => {
    const { pool } = createFakePool({ currentMarkdown: 'old paragraph\n' });
    const liveWriter = createEchoLiveWriter();
    const app = createHttpApp(pool, liveWriter);

    const response = await request(app)
      .post('/api/docs/doc_001/branches/br_main/edit')
      .send({ baseVersionId: 'ver_001', oldString: 'old', newString: 'new', replaceAll: false })
      .expect(200);

    expect(liveWriter.transactions).toEqual([
      {
        branchId: 'br_main',
        targetCanonicalMarkdown: 'new paragraph\n',
        operation: {
          kind: 'edit',
          baseVersionId: 'ver_001',
          oldString: 'old',
          newString: 'new',
          replaceAll: false,
        },
      },
    ]);
    expect(response.body).toMatchObject({ versionId: 'ver_002', versionNumber: 2 });
  });

  it('applies ordered multi-edit operations through one live writer transaction', async () => {
    const { pool } = createFakePool({ currentMarkdown: 'A old\nB old\n' });
    const liveWriter = createEchoLiveWriter();
    const app = createHttpApp(pool, liveWriter);

    const response = await request(app)
      .post('/api/docs/doc_001/branches/br_main/multi-edit')
      .send({
        baseVersionId: 'ver_001',
        edits: [
          { oldString: 'A old', newString: 'A new', replaceAll: false },
          { oldString: 'B old', newString: 'B new', replaceAll: false },
        ],
      })
      .expect(200);

    expect(liveWriter.transactions).toEqual([
      {
        branchId: 'br_main',
        targetCanonicalMarkdown: 'A new\nB new\n',
        operation: {
          kind: 'multi_edit',
          baseVersionId: 'ver_001',
          edits: [
            { oldString: 'A old', newString: 'A new', replaceAll: false },
            { oldString: 'B old', newString: 'B new', replaceAll: false },
          ],
        },
      },
    ]);
    expect(response.body).toMatchObject({ versionId: 'ver_002', versionNumber: 2 });
  });

  it('rejects multi-edit atomically when one ordered operation fails', async () => {
    const { pool, queries } = createFakePool({ currentMarkdown: 'A old\n' });
    const liveWriter = createEchoLiveWriter();
    const app = createHttpApp(pool, liveWriter);

    const response = await request(app)
      .post('/api/docs/doc_001/branches/br_main/multi-edit')
      .send({
        baseVersionId: 'ver_001',
        edits: [
          { oldString: 'A old', newString: 'A new', replaceAll: false },
          { oldString: 'missing', newString: 'new', replaceAll: false },
        ],
      })
      .expect(409);

    expect(response.body).toEqual({ error: 'old_string_not_found', editIndex: 1 });
    expect(liveWriter.transactions).toEqual([]);
    expect(queries.some((sql) => sql.includes('update document_branch_states'))).toBe(false);
    expect(queries.some((sql) => sql.includes('insert into document_versions'))).toBe(false);
  });
});
