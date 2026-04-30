import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createHttpApp } from '../http/app';
import type { DbPool, DbQueryResult, DbTransactionClient } from '../db/client';
import { createUnavailableLiveMarkdownWriter } from '../services/live-writer';

interface CapturedQuery {
  sql: string;
  params?: readonly unknown[];
}

function createFailIfQueriedPool() {
  const queries: CapturedQuery[] = [];

  const query: DbPool['query'] = async <Row = unknown>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<DbQueryResult<Row>> => {
    queries.push(params === undefined ? { sql } : { sql, params });
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

describe('import/export routes with unavailable Milkdown transformer', () => {
  it('exposes create blank doc but fails closed before writing mirror state', async () => {
    const { pool, queries } = createFailIfQueriedPool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter());

    const response = await request(app).post('/api/docs').send({ title: 'Blank doc' }).expect(503);

    expect(response.body).toEqual({ error: 'milkdown_transformer_not_configured' });
    expect(queries).toEqual([]);
  });

  it('exposes import doc but fails closed before storing Markdown beside empty Yjs state', async () => {
    const { pool, queries } = createFailIfQueriedPool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter());

    const response = await request(app)
      .post('/api/docs/import')
      .send({ title: 'Imported doc', markdown: '# Imported\n\nBody\n' })
      .expect(503);

    expect(response.body).toEqual({ error: 'milkdown_transformer_not_configured' });
    expect(queries).toEqual([]);
  });

  it('flushes the live Markdown mirror before export reads branch state', async () => {
    const { pool, queries } = createFailIfQueriedPool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter());

    const response = await request(app).get('/api/docs/doc_001/branches/br_main/export.md').expect(503);

    expect(response.body).toEqual({ error: 'milkdown_transformer_not_configured' });
    expect(queries).toEqual([]);
  });
});
