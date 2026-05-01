import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '@marklab/shared/src/hash';
import { createHttpApp } from '../http/app';
import type { DbPool, DbQueryResult, DbTransactionClient } from '../db/client';
import { toRoomName } from '../collab/persistence';
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

  it('exports the exact flushed payload even when a later branch-state read would differ', async () => {
    const flushedHash = sha256Hex('# Flushed export\n');
    vi.mocked(flushBranchMarkdownMirror).mockResolvedValue({
      branchId: 'br_main',
      markdown: '# Flushed export\n',
      hash: flushedHash,
      versionId: 'ver_011',
      versionNumber: 11,
      createdVersion: true,
    });
    const { pool, queries } = createExportPool({
      currentHash: 'sha256:old',
      versionHash: flushedHash,
      currentMarkdown: '# Concurrent newer mirror\n',
    });
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter());

    const response = await request(app).get('/api/docs/doc_001/branches/br_main/export.md').expect(200);

    expect(response.text).toBe('# Flushed export\n');
    expect(response.headers['content-disposition']).toContain('__v0011__');
    expect(response.headers['content-disposition']).toContain(`__sha-${flushedHash.slice('sha256:'.length, 15)}__`);
    expect(queries.some((query) => query.sql.includes('current_markdown'))).toBe(false);
  });

  it('flushes an active collab document before export serializes body and filename metadata', async () => {
    const staleHash = sha256Hex('# Stale export\n');
    const activeHash = sha256Hex('# Active export\n');
    let activeFlushed = false;
    vi.mocked(flushBranchMarkdownMirror).mockImplementation(async () => {
      if (!activeFlushed) {
        return {
          branchId: 'br_main',
          markdown: '# Stale export\n',
          hash: staleHash,
          versionId: 'ver_003',
          versionNumber: 3,
          createdVersion: false,
        };
      }

      return {
        branchId: 'br_main',
        markdown: '# Active export\n',
        hash: activeHash,
        versionId: 'ver_012',
        versionNumber: 12,
        createdVersion: true,
      };
    });
    const { pool } = createExportPool({
      currentHash: staleHash,
      versionHash: activeHash,
      currentMarkdown: '# Stale export\n',
    });
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter(), {
      async flushCollabDocument(roomName) {
        expect(roomName).toBe(toRoomName('doc_001', 'br_main'));
        activeFlushed = true;
      },
    });

    const response = await request(app).get('/api/docs/doc_001/branches/br_main/export.md').expect(200);

    expect(response.text).toBe('# Active export\n');
    expect(response.headers['content-disposition']).toContain('__v0012__');
    expect(response.headers['content-disposition']).toContain(`__sha-${activeHash.slice('sha256:'.length, 15)}__`);
  });

  it('exports with the flushed version metadata when flush creates a matching manual_save version', async () => {
    const flushedHash = sha256Hex('# Exported\n');
    vi.mocked(flushBranchMarkdownMirror).mockResolvedValue({
      branchId: 'br_main',
      markdown: '# Exported\n',
      hash: flushedHash,
      versionId: 'ver_011',
      versionNumber: 11,
      createdVersion: true,
    });
    const { pool } = createExportPool({
      currentHash: flushedHash,
      versionHash: flushedHash,
      versionId: 'ver_011',
      versionNumber: 11,
    });
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter());

    const response = await request(app).get('/api/docs/doc_001/branches/br_main/export.md').expect(200);

    expect(vi.mocked(flushBranchMarkdownMirror)).toHaveBeenCalledWith(pool, 'doc_001', 'br_main', 'manual_save');
    expect(response.text).toBe('# Exported\n');
    expect(response.headers['content-type']).toContain('text/markdown');
    expect(response.headers['content-disposition']).toContain('__v0011__');
    expect(response.headers['content-disposition']).toContain(`__sha-${flushedHash.slice('sha256:'.length, 15)}__`);
  });

  it('authorizes export against the requested shared branch before flushing', async () => {
    const flushedHash = sha256Hex('# Exported\n');
    vi.mocked(flushBranchMarkdownMirror).mockResolvedValue({
      branchId: 'br_main',
      markdown: '# Exported\n',
      hash: flushedHash,
      versionId: 'ver_011',
      versionNumber: 11,
      createdVersion: true,
    });
    const { pool } = createExportPool({
      currentHash: flushedHash,
      versionHash: flushedHash,
    });
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter(), {
      auth: {
        async requireAdminAccess() {
          throw new Error('forbidden');
        },
        async requireDocumentAccess(_req, docId, branchId, operation) {
          if (docId !== 'doc_001' || branchId !== 'br_main' || operation !== 'read') throw new Error('forbidden');
          return { actorType: 'user', grantId: 'agr_1', role: 'view' };
        },
      },
    });

    await request(app).get('/api/docs/doc_001/branches/br_main/export.md').expect(200);
    await request(app).get('/api/docs/doc_001/branches/br_other/export.md').expect(403, { error: 'forbidden' });
  });

  it('refuses a versioned export filename when the flushed body does not match the flushed hash', async () => {
    vi.mocked(flushBranchMarkdownMirror).mockResolvedValue({
      branchId: 'br_main',
      markdown: '# Exported\n',
      hash: 'sha256:not-the-body',
      versionId: 'ver_011',
      versionNumber: 11,
      createdVersion: false,
    });
    const { pool } = createExportPool({
      currentHash: 'sha256:not-the-body',
      versionHash: 'sha256:not-the-body',
    });
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter());

    const response = await request(app).get('/api/docs/doc_001/branches/br_main/export.md').expect(409);

    expect(response.body).toEqual({
      error: 'export_version_mismatch',
      currentHash: expect.stringMatching(/^sha256:/u),
      versionHash: 'sha256:not-the-body',
    });
  });
});
