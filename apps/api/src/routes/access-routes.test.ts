import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { toRoomName } from '../collab/persistence';
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
  grant_kind?: 'access' | 'share';
  name?: string;
  can_read?: boolean;
  can_write?: boolean;
  role?: 'view' | 'edit';
  expires_at: Date | string | null;
  revoked_at: Date | string | null;
  created_at: Date | string;
  branch_name?: string;
  workspace_id?: string | null;
  folder_id?: string | null;
  created_by_user_id?: string | null;
}

interface SessionRecord {
  id: string;
  grant_id: string;
  doc_id?: string;
  branch_id?: string;
  client_id: string;
  client_kind: 'browser' | 'app' | 'agent' | 'api';
  display_name: string;
  color: string;
  last_branch_id: string | null;
  created_at: Date | string;
  last_seen_at: Date | string;
}

const originalRequireAuth = process.env.MARKLAB_REQUIRE_AUTH;
const originalAdminHash = process.env.MARKLAB_ADMIN_TOKEN_HASH;
const originalDevAnonymousCollab = process.env.MARKLAB_ENABLE_DEV_ANONYMOUS_COLLAB;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

afterEach(() => {
  restoreEnv('MARKLAB_REQUIRE_AUTH', originalRequireAuth);
  restoreEnv('MARKLAB_ADMIN_TOKEN_HASH', originalAdminHash);
  restoreEnv('MARKLAB_ENABLE_DEV_ANONYMOUS_COLLAB', originalDevAnonymousCollab);
});

function requireAuth(adminToken: string) {
  process.env.MARKLAB_REQUIRE_AUTH = 'true';
  process.env.MARKLAB_ADMIN_TOKEN_HASH = hashToken(adminToken);
}

function createAccessRoutePool() {
  const queries: CapturedQuery[] = [];
  const agentTokens: TokenRecord[] = [];
  const shareLinks: TokenRecord[] = [];
  const accessGrants: TokenRecord[] = [];
  const accessSessions: SessionRecord[] = [];
  let nextAgentTokenId = 1;
  let nextShareLinkId = 1;
  let nextAccessGrantId = 1;
  let nextAccessSessionId = 1;

  const query: DbPool['query'] = async <Row = unknown>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<DbQueryResult<Row>> => {
	    queries.push(params === undefined ? { sql } : { sql, params });

	    if (/\(\$[0-9]+ is null or/u.test(sql)) {
	      throw new Error('postgres_nullable_parameter_requires_explicit_type');
	    }

	    if (sql.includes('update user_sessions') && sql.includes('from users')) {
	      const tokenHash = String(params?.[0]);
	      if (tokenHash === hashToken('owner-token')) {
	        return {
	          rows: [{ session_id: 'user_session_1', id: 'user_owner', email: 'owner@example.com', display_name: 'Owner' } as Row],
	          rowCount: 1,
	        };
	      }
	      if (tokenHash === hashToken('reader-token')) {
	        return {
	          rows: [{ session_id: 'user_session_2', id: 'user_reader', email: 'reader@example.com', display_name: 'Reader' } as Row],
	          rowCount: 1,
	        };
	      }
	      return { rows: [], rowCount: 0 };
	    }

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

    if (sql.includes('select doc_id, branch_id, token_hash, can_write') && sql.includes('from agent_tokens')) {
      const row = agentTokens.find((candidate) => candidate.id === params?.[0] && !candidate.revoked_at);
      return { rows: (row ? [row] : []) as Row[], rowCount: row ? 1 : 0 };
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

	    if (sql.includes('insert into document_access_grants')) {
	      if (params?.[1] === 'br_missing') return { rows: [], rowCount: 0 };
	      const row: TokenRecord = {
	        id: `agr_${nextAccessGrantId++}`,
	        doc_id: String(params?.[0]),
	        branch_id: String(params?.[1]),
	        grant_kind: sql.includes("'share'") ? 'share' : 'access',
	        token_hash: String(params?.[2]),
	        role: params?.[3] as 'view' | 'edit',
	        expires_at: (params?.[4] as Date | string | null | undefined) ?? null,
	        revoked_at: null,
	        created_at: new Date('2026-05-01T12:00:00Z'),
	        branch_name: 'main',
	        workspace_id: 'ws_existing',
	        folder_id: 'folder_1',
	        created_by_user_id: (params?.[5] as string | null | undefined) ?? null,
	      };
      accessGrants.push(row);
	      return { rows: [row as Row], rowCount: 1 };
	    }

	    if (sql.includes('from documents d') && sql.includes('left join workspace_members')) {
	      const userAccessCheck = sql.includes('and b.id = $3');
	      const branchId = userAccessCheck ? params?.[2] : params?.[1];
	      const userId = userAccessCheck ? params?.[0] : params?.[2];
	      if (branchId === 'br_missing') return { rows: [], rowCount: 0 };
	      return {
	        rows: [{
	          owner_id: 'user_owner',
	          workspace_id: 'ws_existing',
	          member_role: userId === 'user_owner' ? 'Owner' : userId === 'user_reader' ? 'Reader' : null,
	        } as Row],
	        rowCount: 1,
	      };
	    }

	    if (sql.includes('from document_branches b') && sql.includes('provider_doc_id')) {
	      const branchId = params?.[1] as string | null | undefined;
	      const rows = branchId
	        ? [{ branch_id: branchId, provider_doc_id: `provider_${branchId}` }]
	        : [
	            { branch_id: 'br_main', provider_doc_id: 'provider_br_main' },
	            { branch_id: 'br_notes', provider_doc_id: 'provider_br_notes' },
	          ];
	      return { rows: rows as Row[], rowCount: rows.length };
	    }

	    if (sql.includes('from document_branches') && sql.includes('is_archived = false')) {
      if (params?.[0] === 'br_missing') return { rows: [], rowCount: 0 };
      return { rows: [{ id: params?.[0] } as Row], rowCount: 1 };
    }

	    if (sql.includes('from document_access_grants') && sql.includes('where doc_id = $1')) {
	      const grantKind = sql.includes("grant_kind = 'share'") ? 'share' : sql.includes("grant_kind = 'access'") ? 'access' : null;
      const includeDocumentWide = sql.includes('branch_id is null');
	      const rows = accessGrants
	        .filter((row) => row.doc_id === params?.[0] &&
          (row.branch_id === params?.[1] || (includeDocumentWide && row.branch_id === null)) &&
          !row.revoked_at &&
          (!grantKind || row.grant_kind === grantKind))
	        .map((row) => ({
	          ...row,
	          sessions: accessSessions.filter((session) => session.grant_id === row.id),
        }));
      return { rows: rows as Row[], rowCount: rows.length };
    }

    if (sql.includes('from document_access_grants') && sql.includes('token_hash = $1')) {
      const rows = accessGrants.filter(
        (row) => row.token_hash === params?.[0] && row.doc_id === params?.[1] && row.branch_id === params?.[2],
      );
      return { rows: rows as Row[], rowCount: rows.length };
    }

    if (sql.includes('select id') && sql.includes('from document_access_grants') && sql.includes('for update')) {
      const row = accessGrants.find((grant) => grant.id === params?.[0] && grant.doc_id === params?.[1] && grant.branch_id === params?.[2]);
      return { rows: (row ? [row] : []) as Row[], rowCount: row ? 1 : 0 };
    }

    if (sql.includes('select doc_id, branch_id') && sql.includes('from document_access_grants')) {
      const grantKind = sql.includes("grant_kind = 'share'") ? 'share' : sql.includes("grant_kind = 'access'") ? 'access' : null;
      const row = accessGrants.find((candidate) => candidate.id === params?.[0] && !candidate.revoked_at && (!grantKind || candidate.grant_kind === grantKind));
      return { rows: (row ? [row] : []) as Row[], rowCount: row ? 1 : 0 };
    }

    if (sql.includes('update document_access_grants')) {
      const grantKind = sql.includes("grant_kind = 'share'") ? 'share' : sql.includes("grant_kind = 'access'") ? 'access' : null;
      const row = accessGrants.find((candidate) => candidate.id === params?.[0] && !candidate.revoked_at && (!grantKind || candidate.grant_kind === grantKind));
      if (!row) return { rows: [], rowCount: 0 };
      row.revoked_at = new Date('2026-05-01T12:05:00Z');
      return { rows: [{ id: row.id } as Row], rowCount: 1 };
    }

    if (sql.includes('from document_access_sessions') && sql.includes('grant_id = $1') && sql.includes('client_id = $2')) {
      const row = accessSessions.find((session) => session.grant_id === params?.[0] && session.client_id === params?.[1]);
      return { rows: (row ? [row] : []) as Row[], rowCount: row ? 1 : 0 };
    }

    if (sql.includes('from document_access_sessions') && sql.includes('display_name like')) {
      const rows = accessSessions.filter((session) => session.grant_id === params?.[0] && session.display_name.startsWith('Guest '));
      return { rows: rows as Row[], rowCount: rows.length };
    }

    if (sql.includes('insert into document_access_sessions')) {
      const row: SessionRecord = {
        id: `ses_${nextAccessSessionId++}`,
        grant_id: String(params?.[0]),
        doc_id: String(params?.[1]),
        branch_id: String(params?.[2]),
        client_id: String(params?.[3]),
        client_kind: params?.[4] as 'browser' | 'app' | 'agent' | 'api',
        display_name: String(params?.[5]),
        color: String(params?.[6]),
        last_branch_id: String(params?.[7]),
        created_at: new Date('2026-05-01T12:01:00Z'),
        last_seen_at: new Date('2026-05-01T12:01:00Z'),
      };
      accessSessions.push(row);
      return { rows: [row as Row], rowCount: 1 };
    }

    if (sql.includes('update document_access_sessions')) {
      const row = accessSessions.find((session) => session.grant_id === params?.[0] && session.client_id === params?.[1]);
      if (!row) return { rows: [], rowCount: 0 };
      row.doc_id = String(params?.[2]);
      row.branch_id = String(params?.[3]);
      const nextName = String(params?.[4] ?? '').trim();
      if (nextName) row.display_name = nextName;
      row.last_branch_id = String(params?.[3]);
      row.last_seen_at = new Date('2026-05-01T12:06:00Z');
      return { rows: [row as Row], rowCount: 1 };
    }

    if (sql === 'begin' || sql === 'commit' || sql === 'rollback') {
      return { rows: [], rowCount: 0 };
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

  return { pool, queries, agentTokens, shareLinks, accessGrants, accessSessions };
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

  it('reports full document access for the bootstrap admin token when auth is required', async () => {
    requireAuth('admin-secret');
    const { pool } = createAccessRoutePool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter());

    await request(app)
      .get('/api/docs/doc_001/branches/br_main/access')
      .set({ Authorization: 'Bearer admin-secret' })
      .expect(200, {
        canRead: true,
        canWrite: true,
        actorType: 'user',
      });
  });

  it('does not treat admin tokens in query strings as bootstrap admin access', async () => {
    requireAuth('admin-secret');
    const { pool } = createAccessRoutePool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter());

    await request(app)
      .get('/api/docs/doc_001/branches/br_main/access?token=admin-secret')
      .expect(403, { error: 'forbidden' });
  });

  it('reports document access for logged-in workspace members without a document token', async () => {
    requireAuth('admin-secret');
    const { pool } = createAccessRoutePool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter());

    await request(app)
      .get('/api/docs/doc_001/branches/br_main/access')
      .set({ Authorization: 'Bearer reader-token' })
      .expect(200, {
        canRead: true,
        canWrite: false,
        actorType: 'user',
        role: 'view',
      });
  });

  it('prefers logged-in workspace member identity over an explicit share token', async () => {
    requireAuth('admin-secret');
    const { pool } = createAccessRoutePool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter());
    const admin = { Authorization: 'Bearer admin-secret' };

    const createResponse = await request(app)
      .post('/api/docs/doc_001/branches/br_main/share-links')
      .set(admin)
      .send({ role: 'edit' })
      .expect(201);

    await request(app)
      .get(`/api/docs/doc_001/branches/br_main/access?token=${encodeURIComponent(createResponse.body.token)}`)
      .set({ Authorization: 'Bearer owner-token' })
      .expect(200, {
        canRead: true,
        canWrite: true,
        actorType: 'user',
        role: 'edit',
      });

    await request(app)
      .get('/api/docs/doc_001/branches/br_main/access')
      .set({
        Authorization: `Bearer ${createResponse.body.token}`,
        Cookie: 'marklab_session=owner-token',
      })
      .expect(200, {
        canRead: true,
        canWrite: true,
        actorType: 'user',
        role: 'edit',
      });
  });

  it('does not let a logged-in Reader use an explicit edit link for write access', async () => {
    requireAuth('admin-secret');
    const { pool } = createAccessRoutePool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter());
    const admin = { Authorization: 'Bearer admin-secret' };

    const createResponse = await request(app)
      .post('/api/docs/doc_001/branches/br_main/share-links')
      .set(admin)
      .send({ role: 'edit' })
      .expect(201);

    await request(app)
      .get(`/api/docs/doc_001/branches/br_main/access?token=${encodeURIComponent(createResponse.body.token)}`)
      .set('Cookie', 'marklab_session=reader-token')
      .expect(200, {
        canRead: true,
        canWrite: false,
        actorType: 'user',
        role: 'view',
      });
  });

  it('does not let a logged-in Reader create an edit access session through an explicit access grant', async () => {
    requireAuth('admin-secret');
    const { pool } = createAccessRoutePool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter());
    const admin = { Authorization: 'Bearer admin-secret' };

    const createGrantResponse = await request(app)
      .post('/api/docs/doc_001/branches/br_main/access-grants')
      .set(admin)
      .send({ role: 'edit' })
      .expect(201);

    await request(app)
      .post('/api/docs/doc_001/branches/br_main/access-sessions')
      .set({
        Authorization: `Bearer ${createGrantResponse.body.token}`,
        Cookie: 'marklab_session=reader-token',
      })
      .send({ clientId: 'browser_reader', clientKind: 'browser', displayName: 'Reader' })
      .expect(403, { error: 'forbidden' });
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
    process.env.MARKLAB_ENABLE_DEV_ANONYMOUS_COLLAB = 'true';
    const { pool } = createAccessRoutePool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter());

    await request(app).get('/api/docs/doc_001/branches/br_main/access').expect(200, {
      canRead: true,
      canWrite: true,
      actorType: 'user',
    });
  });

  it('does not allow anonymous document access unless dev anonymous mode is explicit', async () => {
    process.env.MARKLAB_REQUIRE_AUTH = 'false';
    delete process.env.MARKLAB_ENABLE_DEV_ANONYMOUS_COLLAB;
    const { pool } = createAccessRoutePool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter());

    await request(app).get('/api/docs/doc_001/branches/br_main/access').expect(403, { error: 'forbidden' });
  });

  it('does not allow anonymous grant management unless dev anonymous mode is explicit', async () => {
    process.env.MARKLAB_REQUIRE_AUTH = 'false';
    delete process.env.MARKLAB_ENABLE_DEV_ANONYMOUS_COLLAB;
    const { pool } = createAccessRoutePool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter());

    await request(app)
      .post('/api/docs/doc_001/branches/br_main/share-links')
      .send({ role: 'view' })
      .expect(403, { error: 'forbidden' });
  });

  it('creates, lists without raw secret, and revokes agent tokens', async () => {
    requireAuth('admin-secret');
    const { pool, queries, agentTokens } = createAccessRoutePool();
    const closedProviderDocs: string[][] = [];
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter(), {
      closeProviderDocConnections(providerDocIds) {
        closedProviderDocs.push([...providerDocIds]);
      },
    });
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
    expect(closedProviderDocs).toEqual([['provider_br_main']]);
    expect(queries.some((query) => (
      query.sql.includes('update provider_token_issuances')
      && query.params?.[3] === 'agent_token_revoked'
    ))).toBe(true);

    await request(app).delete('/api/agent-tokens/missing').set(admin).expect(404, { error: 'token_not_found' });
  });

  it('creates, lists without raw secret, and revokes share links', async () => {
    requireAuth('admin-secret');
    const { pool, queries, accessGrants } = createAccessRoutePool();
    const closedRooms: string[] = [];
    const closedProviderDocs: string[][] = [];
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter(), {
      closeCollabDocumentConnections(roomName) {
        closedRooms.push(roomName);
      },
      closeProviderDocConnections(providerDocIds) {
        closedProviderDocs.push([...providerDocIds]);
      },
    });
    const admin = { Authorization: 'Bearer admin-secret' };

    const createResponse = await request(app)
      .post('/api/docs/doc_001/branches/br_main/share-links')
      .set(admin)
      .send({ role: 'edit' })
      .expect(201);

    expect(createResponse.body).toMatchObject({
      linkId: 'agr_1',
      token: expect.stringMatching(/^ml_share_/u),
      role: 'edit',
      expiresAt: null,
    });
    expect(accessGrants[0]?.token_hash).toBe(hashToken(createResponse.body.token));
    expect(accessGrants[0]).toMatchObject({
      workspace_id: 'ws_existing',
      folder_id: 'folder_1',
      created_by_user_id: null,
    });

    const listResponse = await request(app)
      .get('/api/docs/doc_001/branches/br_main/share-links')
      .set(admin)
      .expect(200);

    expect(listResponse.body.links).toEqual([
      {
        linkId: 'agr_1',
        role: 'edit',
        expiresAt: null,
        createdAt: '2026-05-01T12:00:00.000Z',
      },
    ]);
    expect(JSON.stringify(listResponse.body)).not.toContain(createResponse.body.token);

    await request(app).delete('/api/share-links/agr_1').set(admin).expect(204);
    expect(accessGrants[0]?.revoked_at).toBeTruthy();
    expect(closedRooms).toEqual([toRoomName('doc_001', 'br_main')]);
    expect(closedProviderDocs).toEqual([['provider_br_main']]);
    expect(queries.some((query) => (
      query.sql.includes('update provider_token_issuances')
      && query.params?.[3] === 'share_link_revoked'
    ))).toBe(true);
    expect(queries.some((query) => /(?:insert into|update) share_links/u.test(query.sql))).toBe(false);

    await request(app).delete('/api/share-links/missing').set(admin).expect(404, { error: 'share_link_not_found' });
  });

  it('creates, lists without raw secret, and revokes unified access grants', async () => {
    requireAuth('admin-secret');
    const { pool, queries, accessGrants } = createAccessRoutePool();
    const closedRooms: string[] = [];
    const closedProviderDocs: string[][] = [];
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter(), {
      closeCollabDocumentConnections(roomName) {
        closedRooms.push(roomName);
      },
      closeProviderDocConnections(providerDocIds) {
        closedProviderDocs.push([...providerDocIds]);
      },
    });
    const admin = { Authorization: 'Bearer admin-secret' };

    const createResponse = await request(app)
      .post('/api/docs/doc_001/branches/br_main/access-grants')
      .set(admin)
      .send({ role: 'edit' })
      .expect(201);

    expect(createResponse.body).toMatchObject({
      grantId: 'agr_1',
      token: expect.stringMatching(/^ml_access_/u),
      role: 'edit',
      branchId: 'br_main',
      expiresAt: null,
      createdAt: '2026-05-01T12:00:00.000Z',
    });
    expect(accessGrants[0]?.token_hash).toBe(hashToken(createResponse.body.token));
    expect(accessGrants[0]).toMatchObject({
      workspace_id: 'ws_existing',
      folder_id: 'folder_1',
      created_by_user_id: null,
    });

    const listResponse = await request(app)
      .get('/api/docs/doc_001/branches/br_main/access-grants')
      .set(admin)
      .expect(200);

    expect(listResponse.body.grants).toEqual([
      {
        grantId: 'agr_1',
        role: 'edit',
        branchId: 'br_main',
        branchName: 'main',
        expiresAt: null,
        revokedAt: null,
        createdAt: '2026-05-01T12:00:00.000Z',
        sessions: [],
      },
    ]);
    expect(JSON.stringify(listResponse.body)).not.toContain(createResponse.body.token);

    await request(app).delete('/api/access-grants/agr_1').set(admin).expect(204);
    expect(accessGrants[0]?.revoked_at).toBeTruthy();
    expect(closedRooms).toEqual([toRoomName('doc_001', 'br_main')]);
    expect(closedProviderDocs).toEqual([['provider_br_main']]);
    expect(queries.some((query) => (
      query.sql.includes('update provider_token_issuances')
      && query.params?.[3] === 'access_grant_revoked'
    ))).toBe(true);

    await request(app).delete('/api/access-grants/missing').set(admin).expect(404, { error: 'access_grant_not_found' });
  });

  it('keeps access grant revocation successful when runtime socket cleanup fails', async () => {
    requireAuth('admin-secret');
    const { pool, queries, accessGrants } = createAccessRoutePool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter(), {
      closeProviderDocConnections() {
        throw new Error('provider_socket_close_failed');
      },
    });
    const admin = { Authorization: 'Bearer admin-secret' };

    await request(app)
      .post('/api/docs/doc_001/branches/br_main/access-grants')
      .set(admin)
      .send({ role: 'edit' })
      .expect(201);

    await request(app).delete('/api/access-grants/agr_1').set(admin).expect(204);
    expect(accessGrants[0]?.revoked_at).toBeTruthy();
    expect(queries.some((query) => (
      query.sql.includes('update provider_token_issuances')
      && query.params?.[3] === 'access_grant_revoked'
    ))).toBe(true);
  });

  it('keeps share links and access grants isolated even though both use document grant rows', async () => {
    requireAuth('admin-secret');
    const { pool } = createAccessRoutePool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter());
    const admin = { Authorization: 'Bearer admin-secret' };

    await request(app)
      .post('/api/docs/doc_001/branches/br_main/share-links')
      .set(admin)
      .send({ role: 'view' })
      .expect(201);
    await request(app)
      .post('/api/docs/doc_001/branches/br_main/access-grants')
      .set(admin)
      .send({ role: 'edit' })
      .expect(201);

    const links = await request(app)
      .get('/api/docs/doc_001/branches/br_main/share-links')
      .set(admin)
      .expect(200);
    expect(links.body.links.map((link: { linkId: string }) => link.linkId)).toEqual(['agr_1']);

    const grants = await request(app)
      .get('/api/docs/doc_001/branches/br_main/access-grants')
      .set(admin)
      .expect(200);
    expect(grants.body.grants.map((grant: { grantId: string }) => grant.grantId)).toEqual(['agr_2']);

    await request(app).delete('/api/share-links/agr_2').set(admin).expect(404, { error: 'share_link_not_found' });
    await request(app).delete('/api/access-grants/agr_1').set(admin).expect(404, { error: 'access_grant_not_found' });
  });

  it('lists and revokes migrated document-wide share links from branch settings', async () => {
    requireAuth('admin-secret');
    const { pool, accessGrants } = createAccessRoutePool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter());
    const admin = { Authorization: 'Bearer admin-secret' };
    accessGrants.push({
      id: 'agr_document_wide_share',
      doc_id: 'doc_001',
      branch_id: null,
      grant_kind: 'share',
      token_hash: hashToken('ml_share_document_wide'),
      role: 'view',
      expires_at: null,
      revoked_at: null,
      created_at: new Date('2026-05-01T12:10:00Z'),
      branch_name: 'All branches',
    });

    const links = await request(app)
      .get('/api/docs/doc_001/branches/br_main/share-links')
      .set(admin)
      .expect(200);
    expect(links.body.links.map((link: { linkId: string }) => link.linkId)).toEqual(['agr_document_wide_share']);

    await request(app)
      .delete('/api/share-links/agr_document_wide_share')
      .set(admin)
      .expect(204);
    expect(accessGrants[0]?.revoked_at).toBeTruthy();
  });

  it('uses ml_access grants for exact branch access and blocks revoked grants', async () => {
    requireAuth('admin-secret');
    const { pool, accessGrants } = createAccessRoutePool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter());
    const admin = { Authorization: 'Bearer admin-secret' };

    const createResponse = await request(app)
      .post('/api/docs/doc_001/branches/br_main/access-grants')
      .set(admin)
      .send({ role: 'view' })
      .expect(201);

    await request(app)
      .get('/api/docs/doc_001/branches/br_main/access')
      .set({ Authorization: `Bearer ${createResponse.body.token}` })
      .expect(200, {
        canRead: true,
        canWrite: false,
        actorType: 'user',
        grantId: 'agr_1',
        role: 'view',
      });

    await request(app)
      .get('/api/docs/doc_001/branches/br_other/access')
      .set({ Authorization: `Bearer ${createResponse.body.token}` })
      .expect(403, { error: 'forbidden' });

    accessGrants[0]!.revoked_at = new Date('2026-05-01T12:05:00Z');

    await request(app)
      .get('/api/docs/doc_001/branches/br_main/access')
      .set({ Authorization: `Bearer ${createResponse.body.token}` })
      .expect(403, { error: 'forbidden' });
  });

  it('rejects access grant creation when the branch does not belong to the document', async () => {
    requireAuth('admin-secret');
    const { pool } = createAccessRoutePool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter());

    await request(app)
      .post('/api/docs/doc_001/branches/br_missing/access-grants')
      .set({ Authorization: 'Bearer admin-secret' })
      .send({ role: 'edit' })
      .expect(404, { error: 'branch_not_found' });
  });

  it('forbids edit-link guests from managing access links for the same branch', async () => {
    requireAuth('admin-secret');
    const { pool } = createAccessRoutePool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter());
    const admin = { Authorization: 'Bearer admin-secret' };

    const editGrantResponse = await request(app)
      .post('/api/docs/doc_001/branches/br_main/access-grants')
      .set(admin)
      .send({ role: 'edit' })
      .expect(201);
    const editGrantAuth = { Authorization: `Bearer ${editGrantResponse.body.token}` };

    await request(app)
      .post('/api/docs/doc_001/branches/br_main/access-grants')
      .set(editGrantAuth)
      .send({ role: 'view' })
      .expect(403, { error: 'forbidden' });

    await request(app)
      .get('/api/docs/doc_001/branches/br_main/access-grants')
      .set(editGrantAuth)
      .expect(403, { error: 'forbidden' });

    await request(app).delete('/api/access-grants/agr_1').set(editGrantAuth).expect(403, { error: 'forbidden' });
  });

  it('allows logged-in workspace owners to manage document access links', async () => {
    requireAuth('admin-secret');
    const { pool, accessGrants } = createAccessRoutePool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter());
    const owner = { Authorization: 'Bearer owner-token' };

    const createResponse = await request(app)
      .post('/api/docs/doc_001/branches/br_main/access-grants')
      .set(owner)
      .send({ role: 'view' })
      .expect(201);

	    expect(createResponse.body).toMatchObject({
	      grantId: 'agr_1',
	      role: 'view',
	      branchId: 'br_main',
	    });
	    expect(accessGrants[0]).toMatchObject({
	      workspace_id: 'ws_existing',
	      folder_id: 'folder_1',
	      created_by_user_id: 'user_owner',
	    });

    const listResponse = await request(app)
      .get('/api/docs/doc_001/branches/br_main/access-grants')
      .set(owner)
      .expect(200);

    expect(listResponse.body.grants.map((grant: { grantId: string }) => grant.grantId)).toEqual(['agr_1']);

    await request(app).delete('/api/access-grants/agr_1').set(owner).expect(204);
    expect(accessGrants.find((grant) => grant.id === 'agr_1')?.revoked_at).toBeTruthy();
  });

  it('creates and reuses editable access sessions protected by the raw access token', async () => {
    requireAuth('admin-secret');
    const { pool } = createAccessRoutePool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter());
    const admin = { Authorization: 'Bearer admin-secret' };

    const createGrantResponse = await request(app)
      .post('/api/docs/doc_001/branches/br_main/access-grants')
      .set(admin)
      .send({ role: 'edit' })
      .expect(201);

    const firstSession = await request(app)
      .post('/api/docs/doc_001/branches/br_main/access-sessions')
      .set({ Authorization: `Bearer ${createGrantResponse.body.token}` })
      .send({ clientId: 'browser_001', clientKind: 'browser', displayName: '  Alex  ' })
      .expect(201);

    expect(firstSession.body).toMatchObject({
      grantId: 'agr_1',
      sessionId: 'ses_1',
      displayName: 'Alex',
      color: expect.stringMatching(/^#[0-9a-f]{6}$/iu),
      role: 'edit',
      canRead: true,
      canWrite: true,
    });

    const guestOne = await request(app)
      .post('/api/docs/doc_001/branches/br_main/access-sessions')
      .set({ Authorization: `Bearer ${createGrantResponse.body.token}` })
      .send({ clientId: 'browser_002', clientKind: 'browser', displayName: '' })
      .expect(201);

    const guestTwo = await request(app)
      .post('/api/docs/doc_001/branches/br_main/access-sessions')
      .set({ Authorization: `Bearer ${createGrantResponse.body.token}` })
      .send({ clientId: 'browser_003', clientKind: 'browser', displayName: ' ' })
      .expect(201);

    expect(guestOne.body.displayName).toBe('Guest 1');
    expect(guestTwo.body.displayName).toBe('Guest 2');

    const repeatSession = await request(app)
      .post('/api/docs/doc_001/branches/br_main/access-sessions')
      .set({ Authorization: `Bearer ${createGrantResponse.body.token}` })
      .send({ clientId: 'browser_001', clientKind: 'browser', displayName: 'Changed' })
      .expect(200);

    expect(repeatSession.body).toMatchObject({
      grantId: 'agr_1',
      sessionId: 'ses_1',
      displayName: 'Changed',
      role: 'edit',
      canWrite: true,
    });
  });

  it('rejects access session creation for view grants', async () => {
    requireAuth('admin-secret');
    const { pool } = createAccessRoutePool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter());
    const admin = { Authorization: 'Bearer admin-secret' };

    const createGrantResponse = await request(app)
      .post('/api/docs/doc_001/branches/br_main/access-grants')
      .set(admin)
      .send({ role: 'view' })
      .expect(201);

    await request(app)
      .post('/api/docs/doc_001/branches/br_main/access-sessions')
      .set({ Authorization: `Bearer ${createGrantResponse.body.token}` })
      .send({ clientId: 'browser_001', clientKind: 'browser', displayName: 'Alex' })
      .expect(403, { error: 'forbidden' });
  });
});
