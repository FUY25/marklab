import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256Hex } from '@marklab/shared/src/hash';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { DbPool } from '../db/client';
import { createHttpApp } from '../http/app';
import { createPostgresLiveMarkdownWriter } from '../services/postgres-live-writer';

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

interface DocRouteResponse {
  docId: string;
  branchId: string;
  versionId: string;
  versionNumber?: number;
  hash: string;
  markdown?: string;
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/u.test(identifier)) {
    throw new Error(`invalid_identifier:${identifier}`);
  }
  return `"${identifier}"`;
}

function withSearchPath(connectionString: string, schemaName: string): string {
  const url = new URL(connectionString);
  const searchPathOption = `-c search_path=${schemaName},public`;
  const existingOptions = url.searchParams.get('options');
  url.searchParams.set('options', existingOptions ? `${existingOptions} ${searchPathOption}` : searchPathOption);
  return url.toString();
}

describeWithDatabase('doc AI routes against real Postgres schema', () => {
  let adminPool: pg.Pool | undefined;
  let pool: pg.Pool | undefined;
  let schemaName: string;

  beforeAll(async () => {
    if (!databaseUrl) return;

    schemaName = `marklab_real_db_e2e_${Date.now()}_${process.pid}`;
    adminPool = new Pool({ connectionString: databaseUrl });
    await adminPool.query(`create schema ${quoteIdentifier(schemaName)}`);

    pool = new Pool({ connectionString: withSearchPath(databaseUrl, schemaName) });
    const schemaSql = readFileSync(join(process.cwd(), 'apps/api/src/db/schema.sql'), 'utf8');
    await pool.query(schemaSql);
  });

  afterAll(async () => {
    await pool?.end();
    if (adminPool) {
      await adminPool.query(`drop schema if exists ${quoteIdentifier(schemaName)} cascade`);
      await adminPool.end();
    }
  });

  it('imports, reads, writes, edits, exports, versions, and stores decodable Yjs state', async () => {
    if (!pool) throw new Error('real_db_pool_not_initialized');

    const dbPool = pool as unknown as DbPool;
    const app = createHttpApp(dbPool, createPostgresLiveMarkdownWriter(dbPool));

    const imported = (
      await request(app)
        .post('/api/docs/import')
        .send({
          title: 'Real DB E2E',
          markdown: '# Real DB E2E\n\nOld paragraph.\n\n- first\n',
        })
        .expect(201)
    ).body as DocRouteResponse;

    expect(imported).toMatchObject({
      docId: expect.any(String),
      branchId: expect.any(String),
      versionId: expect.any(String),
      hash: expect.stringMatching(/^sha256:/u),
    });

    const firstRead = (
      await request(app).get(`/api/docs/${imported.docId}/branches/${imported.branchId}/read`).expect(200)
    ).body as Required<DocRouteResponse>;

    expect(firstRead.versionId).toBe(imported.versionId);
    expect(firstRead.hash).toBe(imported.hash);
    expect(firstRead.markdown).toContain('Old paragraph.');

    const writeMarkdown = '# Real DB E2E\n\nNew paragraph from write_doc.\n\n- first\n';
    const written = (
      await request(app)
        .post(`/api/docs/${imported.docId}/branches/${imported.branchId}/write`)
        .send({
          baseVersionId: firstRead.versionId,
          baseHash: firstRead.hash,
          markdown: writeMarkdown,
        })
        .expect(200)
    ).body as Required<DocRouteResponse>;

    expect(written.versionNumber).toBeGreaterThan(firstRead.versionNumber);
    expect(written.hash).toMatch(/^sha256:/u);

    const afterWrite = (
      await request(app).get(`/api/docs/${imported.docId}/branches/${imported.branchId}/read`).expect(200)
    ).body as Required<DocRouteResponse>;

    expect(afterWrite.versionId).toBe(written.versionId);
    expect(afterWrite.markdown).toContain('New paragraph from write_doc.');

    const edited = (
      await request(app)
        .post(`/api/docs/${imported.docId}/branches/${imported.branchId}/edit`)
        .send({
          oldString: 'New paragraph from write_doc.',
          newString: 'Edited by edit_doc.',
          replaceAll: false,
        })
        .expect(200)
    ).body as Required<DocRouteResponse>;

    expect(edited.versionNumber).toBeGreaterThan(written.versionNumber);
    expect(edited.hash).toMatch(/^sha256:/u);

    const afterEdit = (
      await request(app).get(`/api/docs/${imported.docId}/branches/${imported.branchId}/read`).expect(200)
    ).body as Required<DocRouteResponse>;

    expect(afterEdit.versionId).toBe(edited.versionId);
    expect(afterEdit.hash).toBe(edited.hash);
    expect(afterEdit.markdown).toContain('Edited by edit_doc.');

    const versionsResponse = await request(app)
      .get(`/api/docs/${imported.docId}/branches/${imported.branchId}/versions`)
      .expect(200);
    const versions = versionsResponse.body.versions as Array<{ operation: string; versionNumber: number; hash: string }>;

    expect(versions.map((version) => version.operation)).toEqual(['edit', 'write', 'import']);
    expect(versions[0]).toMatchObject({
      operation: 'edit',
      versionNumber: edited.versionNumber,
      hash: edited.hash,
    });

    const exported = await request(app)
      .get(`/api/docs/${imported.docId}/branches/${imported.branchId}/export.md`)
      .expect(200);

    expect(exported.text).toContain('Edited by edit_doc.');
    expect(exported.headers['content-disposition']).toContain(`__v${String(edited.versionNumber).padStart(4, '0')}__`);
    expect(exported.headers['content-disposition']).toContain(
      `__sha-${sha256Hex(exported.text).replace(/^sha256:/u, '').slice(0, 8)}__`,
    );

    const branchState = await pool.query<{ yjs_state: Buffer; current_markdown: string; current_hash: string }>(
      `select yjs_state, current_markdown, current_hash
         from document_branch_states
        where branch_id = $1`,
      [imported.branchId],
    );
    const row = branchState.rows[0];
    if (!row) throw new Error('branch_state_not_found');
    expect(row.current_markdown).toBe(exported.text);
    expect(row.current_hash).toBe(sha256Hex(exported.text));
    expect(row.yjs_state.byteLength).toBeGreaterThan(0);

    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, row.yjs_state);
    expect(ydoc.getXmlFragment('prosemirror').length).toBeGreaterThan(0);
    ydoc.destroy();
  });
});
