import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHttpApp } from '../http/app';
import type { DbPool, DbQueryResult, DbTransactionClient } from '../db/client';
import { createUnavailableLiveMarkdownWriter } from '../services/live-writer';
import { flushBranchMarkdownMirror } from '../services/milkdown-transformer';

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
  versionId?: string;
  versionNumber?: number;
  currentMarkdown?: string;
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
            version_id: options.versionId ?? 'ver_007',
            version_number: options.versionNumber ?? 7,
            current_hash: options.currentHash,
            current_markdown: options.currentMarkdown ?? '# Exported\n',
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

  it('rejects export when post-flush branch state does not match flushed version metadata', async () => {
    vi.mocked(flushBranchMarkdownMirror).mockResolvedValue({
      branchId: 'br_main',
      markdown: '# Exported\n',
      hash: 'sha256:fresh',
      versionId: 'ver_011',
      versionNumber: 11,
      createdVersion: true,
    });
    const { pool } = createExportPool({ currentHash: 'sha256:old', versionHash: 'sha256:old' });
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter());

    const response = await request(app).get('/api/docs/doc_001/branches/br_main/export.md').expect(409);

    expect(response.body).toEqual({
      error: 'export_version_mismatch',
      currentHash: 'sha256:old',
      versionHash: 'sha256:fresh',
    });
  });

  it('exports with the flushed version metadata when flush creates a matching manual_save version', async () => {
    vi.mocked(flushBranchMarkdownMirror).mockResolvedValue({
      branchId: 'br_main',
      markdown: '# Exported\n',
      hash: 'sha256:fresh',
      versionId: 'ver_011',
      versionNumber: 11,
      createdVersion: true,
    });
    const { pool } = createExportPool({
      currentHash: 'sha256:fresh',
      versionHash: 'sha256:fresh',
      versionId: 'ver_011',
      versionNumber: 11,
    });
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter());

    const response = await request(app).get('/api/docs/doc_001/branches/br_main/export.md').expect(200);

    expect(vi.mocked(flushBranchMarkdownMirror)).toHaveBeenCalledWith(pool, 'doc_001', 'br_main', 'manual_save');
    expect(response.text).toBe('# Exported\n');
    expect(response.headers['content-type']).toContain('text/markdown');
    expect(response.headers['content-disposition']).toContain('__v0011__');
    expect(response.headers['content-disposition']).toContain('__sha-fresh__');
  });
});
