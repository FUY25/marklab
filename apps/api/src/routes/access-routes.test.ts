import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { DbPool, DbQueryResult, DbTransactionClient } from '../db/client';
import { createHttpApp } from '../http/app';
import { createUnavailableLiveMarkdownWriter } from '../services/live-writer';
import { hashToken } from '../services/access-control';

interface CapturedQuery {
  sql: string;
  params?: readonly unknown[];
}

interface TokenRecord {
  id: string;
  doc_id: string;
  branch_id: string | null;
  token_hash: string;
  name?: string;
  can_read?: boolean;
  can_write?: boolean;
  role?: 'view' | 'edit';
  expires_at: Date | string | null;
  revoked_at: Date | string | null;
  created_at: Date | string;
}

const originalRequireAuth = process.env.MARKLAB_REQUIRE_AUTH;
const originalAdminHash = process.env.MARKLAB_ADMIN_TOKEN_HASH;

afterEach(() => {
  process.env.MARKLAB_REQUIRE_AUTH = originalRequireAuth;
  process.env.MARKLAB_ADMIN_TOKEN_HASH = originalAdminHash;
});

function requireAuth(adminToken: string) {
  process.env.MARKLAB_REQUIRE_AUTH = 'true';
  process.env.MARKLAB_ADMIN_TOKEN_HASH = hashToken(adminToken);
}

function createAccessRoutePool() {
  const queries: CapturedQuery[] = [];
  const agentTokens: TokenRecord[] = [];
  const shareLinks: TokenRecord[] = [];
  let nextAgentTokenId = 1;
  let nextShareLinkId = 1;

  const query: DbPool['query'] = async <Row = unknown>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<DbQueryResult<Row>> => {
    queries.push(params === undefined ? { sql } : { sql, params });

    if (sql.includes('insert into agent_tokens')) {
      const row: TokenRecord = {
        id: `agt_${nextAgentTokenId++}`,
        doc_id: String(params?.[0]),
        branch_id: String(params?.[1]),
        token_hash: String(params?.[2]),
        name: String(params?.[3]),
        can_read: Boolean(params?.[4]),
        can_write: Boolean(params?.[5]),
        expires_at: (params?.[6] as Date | string | null | undefined) ?? null,
        revoked_at: null,
        created_at: new Date('2026-04-30T12:00:00Z'),
      };
      agentTokens.push(row);
      return { rows: [row as Row], rowCount: 1 };
    }

    if (sql.includes('from agent_tokens') && sql.includes('where doc_id = $1')) {
      return {
        rows: agentTokens.filter((row) => row.doc_id === params?.[0] && row.branch_id === params?.[1] && !row.revoked_at) as Row[],
        rowCount: agentTokens.length,
      };
    }

    if (sql.includes('from agent_tokens') && sql.includes('token_hash = $1')) {
      const rows = agentTokens.filter(
        (row) => row.token_hash === params?.[0] && row.doc_id === params?.[1] && (row.branch_id === params?.[2] || row.branch_id === null),
      );
      return { rows: rows as Row[], rowCount: rows.length };
    }

    if (sql.includes('update agent_tokens')) {
      const row = agentTokens.find((candidate) => candidate.id === params?.[0] && !candidate.revoked_at);
      if (!row) return { rows: [], rowCount: 0 };
      row.revoked_at = new Date('2026-04-30T12:05:00Z');
      return { rows: [{ id: row.id } as Row], rowCount: 1 };
    }

    if (sql.includes('insert into share_links')) {
      const row: TokenRecord = {
        id: `shr_${nextShareLinkId++}`,
        doc_id: String(params?.[0]),
        branch_id: String(params?.[1]),
        token_hash: String(params?.[2]),
        role: params?.[3] as 'view' | 'edit',
        expires_at: (params?.[4] as Date | string | null | undefined) ?? null,
        revoked_at: null,
        created_at: new Date('2026-04-30T12:00:00Z'),
      };
      shareLinks.push(row);
      return { rows: [row as Row], rowCount: 1 };
    }

    if (sql.includes('from share_links') && sql.includes('where doc_id = $1')) {
      return {
        rows: shareLinks.filter((row) => row.doc_id === params?.[0] && row.branch_id === params?.[1] && !row.revoked_at) as Row[],
        rowCount: shareLinks.length,
      };
    }

    if (sql.includes('from share_links') && sql.includes('token_hash = $1')) {
      const rows = shareLinks.filter(
        (row) => row.token_hash === params?.[0] && row.doc_id === params?.[1] && (row.branch_id === params?.[2] || row.branch_id === null),
      );
      return { rows: rows as Row[], rowCount: rows.length };
    }

    if (sql.includes('update share_links')) {
      const row = shareLinks.find((candidate) => candidate.id === params?.[0] && !candidate.revoked_at);
      if (!row) return { rows: [], rowCount: 0 };
      row.revoked_at = new Date('2026-04-30T12:05:00Z');
      return { rows: [{ id: row.id } as Row], rowCount: 1 };
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

  return { pool, queries, agentTokens, shareLinks };
}

describe('access routes', () => {
  it('requires the admin token when auth mode is enabled', async () => {
    requireAuth('admin-secret');
    const { pool } = createAccessRoutePool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter());

    await request(app)
      .post('/api/docs/doc_001/branches/br_main/agent-tokens')
      .send({ name: 'Codex', canWrite: true })
      .expect(403, { error: 'forbidden' });
  });

  it('reports document access without exposing token secrets', async () => {
    requireAuth('admin-secret');
    const { pool } = createAccessRoutePool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter());
    const admin = { Authorization: 'Bearer admin-secret' };

    const createResponse = await request(app)
      .post('/api/docs/doc_001/branches/br_main/agent-tokens')
      .set(admin)
      .send({ name: 'Read only', canWrite: false })
      .expect(201);

    const accessResponse = await request(app)
      .get('/api/docs/doc_001/branches/br_main/access')
      .set({ Authorization: `Bearer ${createResponse.body.token}` })
      .expect(200);

    expect(accessResponse.body).toEqual({
      canRead: true,
      canWrite: false,
      actorType: 'agent',
    });
    expect(JSON.stringify(accessResponse.body)).not.toContain(createResponse.body.token);
  });

  it('rejects document access introspection for invalid tokens when auth is required', async () => {
    requireAuth('admin-secret');
    const { pool } = createAccessRoutePool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter());

    await request(app)
      .get('/api/docs/doc_001/branches/br_main/access')
      .set({ Authorization: 'Bearer invalid-token' })
      .expect(403, { error: 'forbidden' });
  });

  it('reports full document access when auth mode is disabled', async () => {
    process.env.MARKLAB_REQUIRE_AUTH = 'false';
    const { pool } = createAccessRoutePool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter());

    await request(app).get('/api/docs/doc_001/branches/br_main/access').expect(200, {
      canRead: true,
      canWrite: true,
      actorType: 'user',
    });
  });

  it('creates, lists without raw secret, and revokes agent tokens', async () => {
    requireAuth('admin-secret');
    const { pool, agentTokens } = createAccessRoutePool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter());
    const admin = { Authorization: 'Bearer admin-secret' };

    const createResponse = await request(app)
      .post('/api/docs/doc_001/branches/br_main/agent-tokens')
      .set(admin)
      .send({ name: 'Codex', canWrite: true })
      .expect(201);

    expect(createResponse.body).toMatchObject({
      tokenId: 'agt_1',
      token: expect.stringMatching(/^ml_agent_/u),
      name: 'Codex',
      canRead: true,
      canWrite: true,
      expiresAt: null,
    });
    expect(agentTokens[0]?.token_hash).toBe(hashToken(createResponse.body.token));

    const listResponse = await request(app)
      .get('/api/docs/doc_001/branches/br_main/agent-tokens')
      .set(admin)
      .expect(200);

    expect(listResponse.body.tokens).toEqual([
      {
        tokenId: 'agt_1',
        name: 'Codex',
        canRead: true,
        canWrite: true,
        expiresAt: null,
        createdAt: '2026-04-30T12:00:00.000Z',
      },
    ]);
    expect(JSON.stringify(listResponse.body)).not.toContain(createResponse.body.token);

    await request(app).delete('/api/agent-tokens/agt_1').set(admin).expect(204);
    expect(agentTokens[0]?.revoked_at).toBeTruthy();

    await request(app).delete('/api/agent-tokens/missing').set(admin).expect(404, { error: 'token_not_found' });
  });

  it('creates, lists without raw secret, and revokes share links', async () => {
    requireAuth('admin-secret');
    const { pool, shareLinks } = createAccessRoutePool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter());
    const admin = { Authorization: 'Bearer admin-secret' };

    const createResponse = await request(app)
      .post('/api/docs/doc_001/branches/br_main/share-links')
      .set(admin)
      .send({ role: 'edit' })
      .expect(201);

    expect(createResponse.body).toMatchObject({
      linkId: 'shr_1',
      token: expect.stringMatching(/^ml_share_/u),
      role: 'edit',
      expiresAt: null,
    });
    expect(shareLinks[0]?.token_hash).toBe(hashToken(createResponse.body.token));

    const listResponse = await request(app)
      .get('/api/docs/doc_001/branches/br_main/share-links')
      .set(admin)
      .expect(200);

    expect(listResponse.body.links).toEqual([
      {
        linkId: 'shr_1',
        role: 'edit',
        expiresAt: null,
        createdAt: '2026-04-30T12:00:00.000Z',
      },
    ]);
    expect(JSON.stringify(listResponse.body)).not.toContain(createResponse.body.token);

    await request(app).delete('/api/share-links/shr_1').set(admin).expect(204);
    expect(shareLinks[0]?.revoked_at).toBeTruthy();

    await request(app).delete('/api/share-links/missing').set(admin).expect(404, { error: 'share_link_not_found' });
  });
});
