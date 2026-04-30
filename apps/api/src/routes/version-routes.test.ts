import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { DbPool, DbQueryResult, DbTransactionClient } from '../db/client';
import { createHttpApp } from '../http/app';
import { createUnavailableLiveMarkdownWriter } from '../services/live-writer';
import { initializeBranchEditorState } from '../services/milkdown-transformer';

vi.mock('../services/milkdown-transformer', () => ({
  initializeBranchEditorState: vi.fn(async () => ({
    yjsState: Uint8Array.from([4, 5, 6]),
    markdown: '# Branch copy\n',
    hash: 'sha256:branch-copy',
  })),
  flushBranchMarkdownMirror: vi.fn(async () => undefined),
}));

interface CapturedQuery {
  sql: string;
  params?: readonly unknown[];
}

function createFakePool() {
  const queries: CapturedQuery[] = [];

  const query: DbPool['query'] = async <Row = unknown>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<DbQueryResult<Row>> => {
    queries.push(params === undefined ? { sql } : { sql, params });

    if (sql.includes('from document_versions') && sql.includes('order by version_number desc')) {
      return {
        rows: [
          {
            id: 'ver_002',
            parent_version_id: 'ver_001',
            version_number: 2,
            hash: 'sha256:b',
            actor_type: 'agent',
            actor_id: null,
            operation: 'write',
            created_at: new Date('2026-04-29T12:00:00Z'),
          } as Row,
        ],
        rowCount: 1,
      };
    }

    if (sql.includes('select markdown_snapshot, hash')) {
      return {
        rows: [{ markdown_snapshot: '# Source\n', hash: 'sha256:source' } as Row],
        rowCount: 1,
      };
    }

    if (sql.includes('insert into document_branches')) {
      return { rows: [{ id: 'br_draft' } as Row], rowCount: 1 };
    }

    if (sql.includes('insert into document_versions')) {
      return { rows: [{ id: 'ver_branch' } as Row], rowCount: 1 };
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

describe('version routes', () => {
  it('lists branch versions through the mounted HTTP app', async () => {
    const { pool } = createFakePool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter());

    const response = await request(app).get('/api/docs/doc_001/branches/br_main/versions').expect(200);

    expect(response.body).toEqual({
      versions: [
        {
          versionId: 'ver_002',
          parentVersionId: 'ver_001',
          versionNumber: 2,
          hash: 'sha256:b',
          actorType: 'agent',
          actorId: null,
          operation: 'write',
          createdAt: '2026-04-29T12:00:00.000Z',
        },
      ],
    });
  });

  it('branches from a version through the mounted HTTP app', async () => {
    const { pool, queries } = createFakePool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter());

    const response = await request(app)
      .post('/api/docs/doc_001/versions/ver_001/branch')
      .send({ name: 'Draft Copy' })
      .expect(201);

    expect(response.body).toEqual({ branchId: 'br_draft', headVersionId: 'ver_branch' });
    expect(initializeBranchEditorState).toHaveBeenCalledWith('# Source\n');

    const branchInsert = queries.find((query) => query.sql.includes('insert into document_branches'));
    expect(branchInsert?.params).toEqual(['doc_001', 'Draft Copy', 'draft-copy', 'ver_001']);
  });
});
