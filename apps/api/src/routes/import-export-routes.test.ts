import request from 'supertest';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createHttpApp } from '../http/app';
import type { DbPool, DbQueryResult, DbTransactionClient } from '../db/client';
import { createUnavailableLiveMarkdownWriter } from '../services/live-writer';

interface CapturedQuery {
  sql: string;
  params?: readonly unknown[];
}

function createDocWritePool() {
  const queries: CapturedQuery[] = [];

  const query: DbPool['query'] = async <Row = unknown>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<DbQueryResult<Row>> => {
    queries.push(params === undefined ? { sql } : { sql, params });

    if (sql.includes('insert into documents')) return { rows: [{ id: 'doc_001' } as Row], rowCount: 1 };
    if (sql.includes('insert into document_branches')) return { rows: [{ id: 'br_main' } as Row], rowCount: 1 };
    if (sql.includes('insert into document_versions')) return { rows: [{ id: 'ver_001' } as Row], rowCount: 1 };
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

function findBranchStateInsert(queries: CapturedQuery[]): CapturedQuery | undefined {
  return queries.find((query) => query.sql.includes('insert into document_branch_states'));
}

describe('import/export routes with real Milkdown transformer', () => {
  it('adds CORS headers when JSON parsing fails before route handling', async () => {
    const { pool } = createDocWritePool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter());

    const response = await request(app)
      .post('/api/docs')
      .set('Origin', 'http://127.0.0.1:5173')
      .set('Content-Type', 'application/json')
      .send('{"title":')
      .expect(500);

    expect(response.headers['access-control-allow-origin']).toBe('http://127.0.0.1:5173');
  });

  it('creates a blank doc with initialized branch state and version metadata', async () => {
    const { pool, queries } = createDocWritePool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter());

    const response = await request(app).post('/api/docs').send({ title: 'Blank doc' }).expect(201);

    expect(response.body).toMatchObject({
      docId: 'doc_001',
      branchId: 'br_main',
      versionId: 'ver_001',
    });
    expect(response.body.hash).toMatch(/^sha256:/u);

    const branchStateInsert = findBranchStateInsert(queries);
    const yjsState = branchStateInsert?.params?.[1];
    expect(yjsState).toBeInstanceOf(Buffer);
    expect((yjsState as Buffer).byteLength).toBeGreaterThan(0);
  });

  it('imports markdown with decodable non-empty Yjs branch state', async () => {
    const { pool, queries } = createDocWritePool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter());

    const response = await request(app)
      .post('/api/docs/import')
      .send({ title: 'Imported doc', markdown: '# Imported\n\nBody\n' })
      .expect(201);

    expect(response.body).toMatchObject({
      docId: 'doc_001',
      branchId: 'br_main',
      versionId: 'ver_001',
    });
    expect(response.body.hash).toMatch(/^sha256:/u);

    const branchStateInsert = findBranchStateInsert(queries);
    const yjsState = branchStateInsert?.params?.[1];
    expect(yjsState).toBeInstanceOf(Buffer);

    const doc = new Y.Doc();
    Y.applyUpdate(doc, yjsState as Buffer);
    expect(doc.getXmlFragment('prosemirror').length).toBeGreaterThan(0);
    doc.destroy();
  });
});
