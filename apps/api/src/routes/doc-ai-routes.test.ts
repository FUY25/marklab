import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createHttpApp } from '../http/app';
import type { DbPool, DbQueryResult, DbTransactionClient } from '../db/client';
import type { LiveMarkdownWriter } from '../services/editor-state';

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

function createEchoLiveWriter(): LiveMarkdownWriter & { writes: string[] } {
  const writes: string[] = [];
  return {
    writes,
    async replaceBranchMarkdown(_branchId, canonicalMarkdown) {
      writes.push(canonicalMarkdown);
      return canonicalMarkdown;
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

  it('applies accepted full writes through the live writer before persisting a version', async () => {
    const { pool, queries } = createFakePool();
    const liveWriter = createEchoLiveWriter();
    const app = createHttpApp(pool, liveWriter);

    const response = await request(app)
      .post('/api/docs/doc_001/branches/br_main/write')
      .send({ baseVersionId: 'ver_001', baseHash: 'sha256:current', markdown: '# New\n' })
      .expect(200);

    expect(liveWriter.writes).toEqual(['# New\n']);
    expect(queries.some((sql) => sql.includes('update document_branch_states'))).toBe(true);
    expect(queries.some((sql) => sql.includes('insert into document_versions'))).toBe(true);
    expect(response.body).toMatchObject({ versionId: 'ver_002', versionNumber: 2 });
    expect(response.body.hash).toMatch(/^sha256:/u);
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
});
