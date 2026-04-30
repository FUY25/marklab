import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHttpApp } from '../http/app';
import type { DbPool, DbQueryResult, DbTransactionClient } from '../db/client';
import { createUnavailableLiveMarkdownWriter } from '../services/live-writer';

vi.mock('../services/milkdown-transformer', () => ({
  flushBranchMarkdownMirror: vi.fn(async () => undefined),
}));

interface CapturedQuery {
  sql: string;
  params?: readonly unknown[];
}

interface ExportPoolOptions {
  currentHash: string;
  versionHash: string;
}

function createExportPool(options: ExportPoolOptions) {
  const queries: CapturedQuery[] = [];

  const query: DbPool['query'] = async <Row = unknown>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<DbQueryResult<Row>> => {
    queries.push(params === undefined ? { sql } : { sql, params });

    if (sql.includes('from documents d') && sql.includes('current_markdown')) {
      return {
        rows: [
          {
            doc_id: 'doc_001',
            branch_id: 'br_main',
            version_id: 'ver_007',
            version_number: 7,
            current_hash: options.currentHash,
            current_markdown: '# Exported\n',
          } as Row,
        ],
        rowCount: 1,
      };
    }

    if (sql.includes('b.slug as branch_slug')) {
      return {
        rows: [
          {
            title: 'Exported doc',
            branch_slug: 'main',
            version_hash: options.versionHash,
          } as Row,
        ],
        rowCount: 1,
      };
    }

    return { rows: [], rowCount: 0 };
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

describe('export route version metadata consistency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects export when the flushed mirror hash does not match the branch head version hash', async () => {
    const { pool } = createExportPool({ currentHash: 'sha256:fresh', versionHash: 'sha256:old' });
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter());

    const response = await request(app).get('/api/docs/doc_001/branches/br_main/export.md').expect(409);

    expect(response.body).toEqual({
      error: 'export_version_mismatch',
      currentHash: 'sha256:fresh',
      versionHash: 'sha256:old',
    });
  });

  it('exports markdown when the flushed mirror hash matches the branch head version hash', async () => {
    const { pool } = createExportPool({ currentHash: 'sha256:fresh', versionHash: 'sha256:fresh' });
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter());

    const response = await request(app).get('/api/docs/doc_001/branches/br_main/export.md').expect(200);

    expect(response.text).toBe('# Exported\n');
    expect(response.headers['content-type']).toContain('text/markdown');
    expect(response.headers['content-disposition']).toContain('__v0007__');
    expect(response.headers['content-disposition']).toContain('__sha-fresh__');
  });
});
