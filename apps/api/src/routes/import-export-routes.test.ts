import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createHttpApp } from '../http/app';
import type { DbPool, DbQueryResult, DbTransactionClient } from '../db/client';
import { createUnavailableLiveMarkdownWriter } from '../services/live-writer';
import { hashToken } from '../services/access-control';

interface CapturedQuery {
  sql: string;
  params?: readonly unknown[];
}

const originalRequireAuth = process.env.MARKLAB_REQUIRE_AUTH;
const originalDevAnonymousCollab = process.env.MARKLAB_ENABLE_DEV_ANONYMOUS_COLLAB;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

beforeEach(() => {
  process.env.MARKLAB_REQUIRE_AUTH = 'false';
  process.env.MARKLAB_ENABLE_DEV_ANONYMOUS_COLLAB = 'true';
});

afterEach(() => {
  restoreEnv('MARKLAB_REQUIRE_AUTH', originalRequireAuth);
  restoreEnv('MARKLAB_ENABLE_DEV_ANONYMOUS_COLLAB', originalDevAnonymousCollab);
});

type WorkspaceRole = 'Owner' | 'Member' | 'Reader';

function createDocWritePool(input: { workspaceRole?: WorkspaceRole } = {}) {
  const queries: CapturedQuery[] = [];
  const users = [
    { id: 'user_owner', email: 'owner@example.com', display_name: 'Owner' },
    { id: 'user_member', email: 'member@example.com', display_name: 'Member' },
    { id: 'user_reader', email: 'reader@example.com', display_name: 'Reader' },
  ];
  const sessions = new Map([
    [hashToken('owner-token'), 'user_owner'],
    [hashToken('member-token'), 'user_member'],
    [hashToken('reader-token'), 'user_reader'],
  ]);
  const documents: Array<{ id: string; title: string; owner_id: string | null; workspace_id: string | null; default_branch_id: string | null }> = [];

  const query: DbPool['query'] = async <Row = unknown>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<DbQueryResult<Row>> => {
    queries.push(params === undefined ? { sql } : { sql, params });

    if (sql.includes('update user_sessions') && sql.includes('from users')) {
      const userId = sessions.get(String(params?.[0]));
      const user = users.find((candidate) => candidate.id === userId);
      if (!user) return { rows: [], rowCount: 0 };
      return { rows: [{ session_id: 'session', id: user.id, email: user.email, display_name: user.display_name } as Row], rowCount: 1 };
    }
    if (sql.includes('select role') && sql.includes('from workspace_members')) {
      return input.workspaceRole ? { rows: [{ role: input.workspaceRole } as Row], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (sql.includes('insert into documents')) {
      const row = {
        id: `doc_${String(documents.length + 1).padStart(3, '0')}`,
        title: String(params?.[0]),
        owner_id: (params?.[1] as string | null | undefined) ?? null,
        workspace_id: (params?.[2] as string | null | undefined) ?? null,
        default_branch_id: null,
      };
      documents.push(row);
      return { rows: [{ id: row.id } as Row], rowCount: 1 };
    }
    if (sql.includes('insert into document_branches')) return { rows: [{ id: 'br_main' } as Row], rowCount: 1 };
    if (sql.includes('insert into document_versions')) return { rows: [{ id: 'ver_001' } as Row], rowCount: 1 };
    if (sql.includes('update documents') && sql.includes('default_branch_id')) {
      const document = documents.find((candidate) => candidate.id === params?.[0]);
      if (document) document.default_branch_id = String(params?.[1]);
      return { rows: [], rowCount: document ? 1 : 0 };
    }
    if (sql.includes('from documents d') && sql.includes('left join document_access_grants')) {
      const rows = documents
        .filter((document) => document.workspace_id === params?.[0])
        .map((document) => ({
          id: document.id,
          title: document.title,
          default_branch_id: document.default_branch_id,
          view_grant_count: 0,
          edit_grant_count: 0,
        }));
      return { rows: rows as Row[], rowCount: rows.length };
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

  return { pool, queries, documents };
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
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter(), {
      auth: {
        async requireAdminAccess() {
          return { actorType: 'user', actorId: 'user_creator' };
        },
        async requireDocumentAccess() {
          throw new Error('forbidden');
        },
      },
    });

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

    const versionInsert = queries.find((query) => query.sql.includes('insert into document_versions'));
    expect(versionInsert?.params?.slice(4)).toEqual(['user', 'user_creator', 'create']);
  });

  it('lets a workspace member create a document owned by that workspace without an admin token', async () => {
    const { pool, queries, documents } = createDocWritePool({ workspaceRole: 'Member' });
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter());

    const response = await request(app)
      .post('/api/docs')
      .set({ Authorization: 'Bearer member-token' })
      .send({ title: 'Workspace doc', workspaceId: 'ws_existing' })
      .expect(201);

    expect(response.body).toMatchObject({
      docId: 'doc_001',
      branchId: 'br_main',
      versionId: 'ver_001',
    });
    expect(documents[0]).toMatchObject({
      id: 'doc_001',
      title: 'Workspace doc',
      owner_id: 'user_member',
      workspace_id: 'ws_existing',
      default_branch_id: 'br_main',
    });

    const versionInsert = queries.find((query) => query.sql.includes('insert into document_versions'));
    expect(versionInsert?.params?.slice(4)).toEqual(['user', 'user_member', 'create']);

    await request(app)
      .get('/api/workspaces/ws_existing/documents')
      .set({ Authorization: 'Bearer member-token' })
      .expect(200, {
        documents: [{
          docId: 'doc_001',
          title: 'Workspace doc',
          defaultBranchId: 'br_main',
          viewGrantCount: 0,
          editGrantCount: 0,
        }],
      });
  });

  it('lets a workspace owner import markdown into that workspace without an admin token', async () => {
    const { pool, queries, documents } = createDocWritePool({ workspaceRole: 'Owner' });
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter());

    await request(app)
      .post('/api/docs/import')
      .set({ Authorization: 'Bearer owner-token' })
      .send({ title: 'Workspace import', markdown: '# Imported\n', workspaceId: 'ws_existing' })
      .expect(201);

    expect(documents[0]).toMatchObject({
      title: 'Workspace import',
      owner_id: 'user_owner',
      workspace_id: 'ws_existing',
      default_branch_id: 'br_main',
    });
    const versionInsert = queries.find((query) => query.sql.includes('insert into document_versions'));
    expect(versionInsert?.params?.slice(4)).toEqual(['user', 'user_owner', 'import']);
  });

  it('forbids workspace Readers from creating workspace documents', async () => {
    const { pool, documents } = createDocWritePool({ workspaceRole: 'Reader' });
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter());

    await request(app)
      .post('/api/docs')
      .set({ Authorization: 'Bearer reader-token' })
      .send({ title: 'Denied doc', workspaceId: 'ws_existing' })
      .expect(403, { error: 'forbidden' });

    expect(documents).toEqual([]);
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
