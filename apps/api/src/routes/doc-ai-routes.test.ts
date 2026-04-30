import request from 'supertest';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createHttpApp } from '../http/app';
import type { DbPool, DbQueryResult, DbTransactionClient } from '../db/client';
import { createUnavailableLiveMarkdownWriter } from '../services/live-writer';
import type { LiveMarkdownTransaction, LiveMarkdownWriter } from '../services/live-writer';

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

    if (sql.includes('from document_branches b') && sql.includes('document_branch_states')) {
      return {
        rows: [
          {
            current_markdown: currentMarkdown,
            current_hash: currentHash,
            head_version_id: currentVersionId,
            head_hash: currentHash,
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
        yjsState: createValidYjsState(),
        changedRangeCount: 1,
        appliedTransactionCount: 1,
      };
    },
  };
}

function createValidYjsState(): Uint8Array {
  const doc = new Y.Doc();
  doc.getText('prosemirror').insert(0, 'live state');
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
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
      .send({ oldString: 'old', newString: 'new', replaceAll: false })
      .expect(409);

    expect(response.body).toEqual({ error: 'ambiguous_match', matchCount: 2 });
  });

  it('passes exact edit operation metadata without stale base guards to the live writer transaction', async () => {
    const { pool } = createFakePool({ currentMarkdown: 'old paragraph\n' });
    const liveWriter = createEchoLiveWriter();
    const app = createHttpApp(pool, liveWriter);

    const response = await request(app)
      .post('/api/docs/doc_001/branches/br_main/edit')
      .send({ observedVersionId: 'ver_seen', oldString: 'old', newString: 'new', replaceAll: false })
      .expect(200);

    expect(liveWriter.transactions).toEqual([
      {
        branchId: 'br_main',
        targetCanonicalMarkdown: 'new paragraph\n',
        operation: {
          kind: 'edit',
          observedVersionId: 'ver_seen',
          oldString: 'old',
          newString: 'new',
          replaceAll: false,
        },
      },
    ]);
    expect(response.body).toMatchObject({ versionId: 'ver_002', versionNumber: 2 });
  });

  it('accepts exact edits even when the optional observed version is stale', async () => {
    const { pool } = createFakePool({ currentMarkdown: 'old paragraph\n', currentVersionId: 'ver_current' });
    const liveWriter = createEchoLiveWriter();
    const app = createHttpApp(pool, liveWriter);

    const response = await request(app)
      .post('/api/docs/doc_001/branches/br_main/edit')
      .send({ observedVersionId: 'ver_old', oldString: 'old', newString: 'new', replaceAll: false })
      .expect(200);

    expect(liveWriter.transactions[0]?.operation).toEqual({
      kind: 'edit',
      observedVersionId: 'ver_old',
      oldString: 'old',
      newString: 'new',
      replaceAll: false,
    });
    expect(response.body).toMatchObject({ versionId: 'ver_002', versionNumber: 2 });
  });

  it('does not expose a public multi-edit route', async () => {
    const { pool } = createFakePool({ currentMarkdown: 'A old\nB old\n' });
    const liveWriter = createEchoLiveWriter();
    const app = createHttpApp(pool, liveWriter);

    await request(app)
      .post('/api/docs/doc_001/branches/br_main/multi-edit')
      .send({
        edits: [
          { oldString: 'A old', newString: 'A new', replaceAll: false },
          { oldString: 'B old', newString: 'B new', replaceAll: false },
        ],
      })
      .expect(404);

    expect(liveWriter.transactions).toEqual([]);
  });
});
