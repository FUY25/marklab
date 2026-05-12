import { createHash } from 'node:crypto';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DbPool, DbQueryResult, DbTransactionClient } from '../db/client';
import { createHttpApp, type HttpRequestAuth } from '../http/app';
import { PROVIDER_TOKEN_TTL_SECONDS } from '../config/provider-token-policy';
import type { ProviderTokenService } from '../provider/ysweet-token-service';
import { createUnavailableLiveMarkdownWriter } from '../services/live-writer';
import { generateAccessToken, generateShareToken, hashToken } from '../services/access-control';

const originalRequireAuth = process.env.MARKLAB_REQUIRE_AUTH;
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
  restoreEnv('MARKLAB_ENABLE_DEV_ANONYMOUS_COLLAB', originalDevAnonymousCollab);
});

function createPool(input: {
  failAuditInsert?: boolean;
  activeSessionId?: string;
  activeSessionActorId?: string | null;
  activeSessionActorGrantId?: string | null;
  activeSessionActorType?: 'agent' | 'user';
  activeSessionClientKind?: 'browser' | 'app' | 'daemon' | 'agent' | 'guest';
  activeSessionStatus?: 'pending' | 'issued' | 'failed' | 'revoked';
  activeSessionRefreshTokenHash?: string | null;
  activeSessionIsGuest?: boolean;
  deleteBeforeMarkIssued?: boolean;
  activeGuestSessions?: number;
  guestQuota?: number;
  revokeDuringRefresh?: boolean;
  missingCollabSession?: boolean;
  providerPolicyDenyReason?: 'collab_session_not_found' | 'forbidden' | 'grant_revoked' | 'grant_expired' | 'provider_token_revoked';
  missingBranchState?: boolean;
  initialProviderDocId?: string | null;
  initialProviderDocSeededAt?: string | null;
  providerDocSeededBeforeTokenIssue?: boolean;
  failSeedMarkOnce?: boolean;
	  documentAccessGrantTokenHash?: string;
	  documentAccessGrantRole?: 'view' | 'edit';
	  documentAccessGrantRevoked?: boolean;
	  documentAccessGrantExpired?: boolean;
  readerMemberRole?: 'Owner' | 'Member' | 'Reader' | null;
	  legacyShareTokenHash?: string;
	  legacyShareRole?: 'view' | 'edit';
	} = {}): DbPool & {
	  collabSessions: readonly (readonly unknown[])[];
	  documentAccessSessions: readonly (readonly unknown[])[];
	  collabSessionTouches: readonly (readonly unknown[])[];
  collabSessionFailures: readonly (readonly unknown[])[];
	  providerDocSeedMarks: readonly (readonly unknown[])[];
	  providerDocSeedReads: readonly (readonly unknown[])[];
	  providerDocSeedLocks: readonly (readonly unknown[])[];
	  issuances: readonly (readonly unknown[])[];
	  statusUpdates: readonly (readonly unknown[])[];
	  refreshAttempts: readonly (readonly unknown[])[];
	  refreshIssued: readonly (readonly unknown[])[];
	  refreshDenied: readonly (readonly unknown[])[];
	} {
  const serverSessionId = 'session_server';
  let providerDocId = Object.hasOwn(input, 'initialProviderDocId') ? input.initialProviderDocId ?? null : 'ml_doc_existing';
  let providerDocSeededAt = providerDocId
    ? Object.hasOwn(input, 'initialProviderDocSeededAt') ? input.initialProviderDocSeededAt ?? null : '2026-05-11T00:00:00.000Z'
    : null;
  let seedMarkFailuresRemaining = input.failSeedMarkOnce ? 1 : 0;
	  const collabSessions: (readonly unknown[])[] = [];
	  const documentAccessSessions: (readonly unknown[])[] = [];
	  const collabSessionTouches: (readonly unknown[])[] = [];
  const collabSessionFailures: (readonly unknown[])[] = [];
	  const providerDocSeedMarks: (readonly unknown[])[] = [];
	  const providerDocSeedReads: (readonly unknown[])[] = [];
	  const providerDocSeedLocks: (readonly unknown[])[] = [];
	  const issuances: (readonly unknown[])[] = [];
	  const statusUpdates: (readonly unknown[])[] = [];
	  const refreshAttempts: (readonly unknown[])[] = [];
	  const refreshIssued: (readonly unknown[])[] = [];
	  const refreshDenied: (readonly unknown[])[] = [];
  const query: DbPool['query'] = async <Row = unknown>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<DbQueryResult<Row>> => {
	    if (/insert into collab_sessions/u.test(sql)) {
	      collabSessions.push(params ?? []);
	      return { rows: [{ id: params?.[0] } as Row], rowCount: 1 };
	    }
	    if (/insert into document_access_sessions/u.test(sql)) {
	      documentAccessSessions.push(params ?? []);
	      return { rows: [], rowCount: 1 };
	    }
    if (/update collab_sessions/u.test(sql) && /status = 'failed'/u.test(sql)) {
      collabSessionFailures.push(params ?? []);
      return { rows: [], rowCount: input.missingCollabSession ? 0 : 1 };
    }
    if (/update collab_sessions/u.test(sql)) {
      collabSessionTouches.push(params ?? []);
      return { rows: [], rowCount: input.missingCollabSession ? 0 : 1 };
    }
    if (/update document_branch_states[\s\S]+provider_doc_seeded_at = now/u.test(sql)) {
      if (seedMarkFailuresRemaining > 0) {
        seedMarkFailuresRemaining -= 1;
        throw new Error('seed_mark_failed');
      }
      providerDocSeededAt = '2026-05-11T00:00:00.000Z';
      providerDocSeedMarks.push(params ?? []);
      return { rows: [], rowCount: 1 };
    }
    if (/update document_branch_states/u.test(sql)) {
      providerDocId = String(params?.[2]);
      providerDocSeededAt = null;
      return { rows: [{ provider_doc_id: providerDocId, provider_doc_seeded_at: providerDocSeededAt, yjs_state: Buffer.from([1, 2, 3]) } as Row], rowCount: 1 };
    }
	    if (/insert into provider_token_issuances/u.test(sql)) {
	      if (input.failAuditInsert) throw new Error('audit_insert_failed');
	      issuances.push(params ?? []);
	      return { rows: [{ id: `issuance_${issuances.length}` } as Row], rowCount: 1 };
	    }
	    if (/insert into provider_token_refreshes/u.test(sql)) {
	      refreshAttempts.push(params ?? []);
	      return { rows: [{ id: `refresh_${refreshAttempts.length}` } as Row], rowCount: 1 };
	    }
	    if (/update provider_token_refreshes/u.test(sql) && /issued_at = now/u.test(sql)) {
	      refreshIssued.push(params ?? []);
	      return { rows: [], rowCount: 1 };
	    }
	    if (/update provider_token_refreshes/u.test(sql) && /denied_at = now/u.test(sql)) {
	      refreshDenied.push(params ?? []);
	      return { rows: [], rowCount: 1 };
	    }
    if (/^(begin|commit|rollback)$/iu.test(sql.trim())) return { rows: [], rowCount: 0 };
    if (/pg_advisory_xact_lock/u.test(sql)) {
      providerDocSeedLocks.push(params ?? []);
      return { rows: [{} as Row], rowCount: 1 };
    }
    if (/update user_sessions/u.test(sql) && /from users/u.test(sql)) {
      if (params?.[0] === hashToken('reader-token')) {
        return {
          rows: [{ session_id: 'user_session_reader', id: 'user_reader', email: 'reader@example.com', display_name: 'Reader' } as Row],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    }
    if (/from agent_tokens/u.test(sql) && /token_hash = \$1/u.test(sql)) {
      return { rows: [], rowCount: 0 };
    }
    if (/from share_links/u.test(sql) && /token_hash = \$1/u.test(sql)) {
      if (params?.[0] !== input.legacyShareTokenHash) return { rows: [], rowCount: 0 };
      return {
        rows: [{
          id: 'legacy_share_1',
          role: input.legacyShareRole ?? 'view',
          expires_at: null,
          revoked_at: null,
        } as Row],
        rowCount: 1,
      };
    }
    if (/from document_access_grants g/u.test(sql) && /where g\.id::text = \$1/u.test(sql)) {
      const expectedGrantId = Object.hasOwn(input, 'activeSessionActorGrantId') ? input.activeSessionActorGrantId ?? null : 'grant_1';
      if (!expectedGrantId || params?.[0] !== expectedGrantId) return { rows: [], rowCount: 0 };
      return {
        rows: [{
          role: input.documentAccessGrantRole ?? 'edit',
          revoked_at: input.documentAccessGrantRevoked ? '2026-05-11T00:00:00.000Z' : null,
          expired: input.documentAccessGrantExpired ?? false,
        } as Row],
        rowCount: 1,
      };
    }
    if (/from document_access_grants/u.test(sql) && /token_hash = \$1/u.test(sql)) {
      if (params?.[0] !== input.documentAccessGrantTokenHash) return { rows: [], rowCount: 0 };
      return {
        rows: [{
          id: 'share_grant_1',
          role: input.documentAccessGrantRole ?? 'edit',
          expires_at: null,
          revoked_at: input.documentAccessGrantRevoked ? '2026-05-11T00:00:00.000Z' : null,
        } as Row],
        rowCount: 1,
      };
    }
    if (/^\s*select d\.owner_id/u.test(sql) && /from documents d/u.test(sql) && /left join workspace_members/u.test(sql)) {
      return {
	        rows: [{
	          owner_id: 'user_owner',
	          workspace_id: 'ws_1',
	          member_role: input.readerMemberRole ?? null,
	        } as Row],
        rowCount: 1,
      };
    }
    if (/select 1\s+from provider_token_issuances pending/u.test(sql)) {
      return { rows: input.revokeDuringRefresh ? [] : [{ active: 1 } as Row], rowCount: input.revokeDuringRefresh ? 0 : 1 };
    }
    if (/provider_token_issuance_policy_reason/u.test(sql)) {
      return {
        rows: [{
          deny_reason: input.providerPolicyDenyReason ?? (input.revokeDuringRefresh ? 'grant_revoked' : 'collab_session_not_found'),
        } as Row],
        rowCount: 1,
      };
    }
    if (/pending\.status = 'pending'/u.test(sql)) {
      statusUpdates.push(params ?? []);
      return { rows: [], rowCount: input.revokeDuringRefresh || input.deleteBeforeMarkIssued ? 0 : 1 };
    }
    if (/update provider_token_issuances/u.test(sql)) {
      statusUpdates.push(params ?? []);
      return { rows: [], rowCount: 1 };
    }
    if (/count\(\*\) as active_guest_sessions/u.test(sql)) {
      return { rows: [{ active_guest_sessions: String(input.activeGuestSessions ?? 0) } as Row], rowCount: 1 };
    }
    if (/coalesce\(sl\.concurrent_guest_edits/u.test(sql)) {
      return { rows: [{ concurrent_guest_edits: String(input.guestQuota ?? 3) } as Row], rowCount: 1 };
    }
    if (/from provider_token_issuances/u.test(sql)) {
      if (input.missingCollabSession) return { rows: [], rowCount: 0 };
      const sessionId = params?.[2];
      const refreshTokenHash = params?.[3];
      const expectedRefreshTokenHash = Object.hasOwn(input, 'activeSessionRefreshTokenHash')
        ? input.activeSessionRefreshTokenHash ?? null
        : testRefreshTokenHash(serverSessionRefreshToken);
      if (expectedRefreshTokenHash && refreshTokenHash !== expectedRefreshTokenHash) {
        return { rows: [], rowCount: 0 };
      }
      const activeSessionId = input.activeSessionId ?? serverSessionId;
      const activeActorGrantId = Object.hasOwn(input, 'activeSessionActorGrantId') ? input.activeSessionActorGrantId ?? null : 'grant_1';
      const activeActorId = Object.hasOwn(input, 'activeSessionActorId')
        ? input.activeSessionActorId ?? null
        : activeActorGrantId
          ? `session:${activeSessionId}`
          : 'user_1';
      return {
        rows: sessionId === activeSessionId
          ? [{
            provider_doc_id: 'ml_doc_existing',
            client_kind: input.activeSessionClientKind ?? 'guest',
            actor_type: input.activeSessionActorType ?? 'user',
            actor_id: activeActorId,
            actor_grant_id: activeActorGrantId,
            is_guest: input.activeSessionIsGuest ?? Boolean(activeActorGrantId),
            display_name: 'Guest',
            status: input.activeSessionStatus ?? 'issued',
          } as Row]
          : [],
        rowCount: sessionId === activeSessionId ? 1 : 0,
      };
    }
    if (/select .*provider_doc_id/us.test(sql) && /for update of s/u.test(sql)) {
      providerDocSeedReads.push(params ?? []);
      return {
        rows: [{
          provider_doc_id: providerDocId,
          provider_doc_seeded_at: input.providerDocSeededBeforeTokenIssue
            ? '2026-05-11T00:00:00.000Z'
            : providerDocSeededAt,
          yjs_state: Buffer.from([1, 2, 3]),
        } as Row],
        rowCount: 1,
      };
    }
    if (/select .*provider_doc_id/us.test(sql)) {
      return {
        rows: [{
          provider_doc_id: providerDocId,
          provider_doc_seeded_at: providerDocSeededAt,
          yjs_state: Buffer.from([1, 2, 3]),
        } as Row],
        rowCount: 1,
      };
    }
    if (/from documents d/u.test(sql)) {
      if (input.missingBranchState) return { rows: [], rowCount: 0 };
      return {
        rows: [{
          doc_id: params?.[0],
          branch_id: params?.[1],
          version_id: 'version_1',
          version_number: 1,
          current_hash: 'sha256:markdown',
          current_markdown: '# Visible\n',
        } as Row],
        rowCount: 1,
      };
    }
    throw new Error(`unexpected_query:${sql}`);
  };

  return {
	    collabSessions,
	    documentAccessSessions,
	    collabSessionTouches,
    collabSessionFailures,
	    providerDocSeedMarks,
	    providerDocSeedReads,
	    providerDocSeedLocks,
	    issuances,
	    statusUpdates,
	    refreshAttempts,
	    refreshIssued,
	    refreshDenied,
    query,
    async connect(): Promise<DbTransactionClient> {
      return {
        query,
        release: () => undefined,
      };
    },
  };
}

function createAuth(input: {
  denyRead?: boolean;
  denyWrite?: boolean;
  grantId?: string | null;
  actorId?: string | null;
  actorType?: 'agent' | 'user';
} = {}): HttpRequestAuth & { operations: string[] } {
  const operations: string[] = [];
  return {
    operations,
    async requireAdminAccess() {},
    async requireDocumentAccess(_req, _docId, _branchId, operation) {
      operations.push(operation);
      if (operation === 'read' && input.denyRead) throw new Error('forbidden');
      if (operation === 'write' && input.denyWrite) throw new Error('forbidden');
      const grantId = input.grantId === null ? undefined : input.grantId ?? 'grant_1';
      const defaultActorId = grantId ? 'share:token_hash' : 'user_1';
      return {
        actorType: input.actorType ?? 'user',
        ...(input.actorId === null ? {} : { actorId: input.actorId ?? defaultActorId }),
        ...(grantId ? { grantId, grantSource: 'document_access_grants' as const, role: operation === 'write' ? 'edit' : 'view' } : {}),
      };
    },
  };
}

function createProviderTokenService(options: { failIssue?: boolean; failFirstIssue?: boolean; failMessage?: string } = {}): ProviderTokenService & { issued: unknown[] } {
  const issued: unknown[] = [];
  return {
    issued,
    async issueProviderToken(request) {
      issued.push(request);
      if (options.failIssue || (options.failFirstIssue && issued.length === 1)) {
        throw new Error(options.failMessage ?? 'ysweet_down');
      }
      return {
        providerDocId: request.providerDocId,
        sessionId: request.sessionId,
        authorization: request.authorization,
        validForSeconds: request.validForSeconds ?? PROVIDER_TOKEN_TTL_SECONDS,
        issuedAt: '2026-05-11T00:00:00.000Z',
        expiresAt: '2026-05-11T00:10:00.000Z',
        clientToken: {
          url: 'ws://ysweet.example.test',
          baseUrl: 'http://ysweet.example.test/doc/ml_doc_existing',
          docId: request.providerDocId,
          token: 'ysweet_token',
          authorization: request.authorization,
        },
        ...(request.sessionIdentity ? { sessionIdentity: request.sessionIdentity } : {}),
      };
    },
  };
}

const serverSessionRefreshToken = 'refresh_token_session_server_0123456789abcdef';

function testRefreshTokenHash(refreshToken: string): string {
  return `sha256:${createHash('sha256').update(refreshToken).digest('hex')}`;
}

describe('collab session routes', () => {
  it('issues an edit provider token only after write access succeeds', async () => {
    const auth = createAuth();
    const providerTokenService = createProviderTokenService();
    const pool = createPool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter(), { auth, providerTokenService });

    const response = await request(app)
      .post('/api/docs/doc_1/branches/branch_1/collab/session')
      .send({ mode: 'edit', clientKind: 'browser', displayName: 'Alice' })
      .expect(201);

    expect(auth.operations).toEqual(['write']);
    expect(providerTokenService.issued).toEqual([expect.objectContaining({
      providerDocId: 'ml_doc_existing',
      authorization: 'full',
      validForSeconds: PROVIDER_TOKEN_TTL_SECONDS,
      sessionIdentity: expect.objectContaining({
        actorType: 'user',
        displayName: 'Alice',
        isGuest: true,
      }),
    })]);
    expect(response.body.providerToken.sessionIdentity).toEqual(expect.objectContaining({
      actorType: 'user',
      actorId: `session:${response.body.session.sessionId}`,
      displayName: 'Alice',
      isGuest: true,
    }));
    expect(response.body.providerToken.clientToken.token).toBe('ysweet_token');
    expect(response.body.providerToken.clientToken.authorization).toBe('full');
    expect(pool.issuances[0]).toEqual(expect.arrayContaining([
      'browser',
      'user',
      `session:${response.body.session.sessionId}`,
      'grant_1',
      'full',
      PROVIDER_TOKEN_TTL_SECONDS,
      'pending',
    ]));
    expect(pool.statusUpdates[0]).toEqual(['issuance_1', 'doc_1', 'branch_1', response.body.session.sessionId]);
  });

  it('ignores client-supplied session ids and returns a server-generated edit session id', async () => {
    const auth = createAuth();
    const providerTokenService = createProviderTokenService();
    const app = createHttpApp(createPool(), createUnavailableLiveMarkdownWriter(), { auth, providerTokenService });

    const response = await request(app)
      .post('/api/docs/doc_1/branches/branch_1/collab/session')
      .send({ mode: 'edit', clientKind: 'browser', displayName: 'Alice', sessionId: 'spoofed_session' })
      .expect(201);

    expect(response.body.session.sessionId).toMatch(/^session_[0-9a-f-]{36}$/u);
    expect(response.body.session.sessionId).not.toBe('spoofed_session');
    expect(providerTokenService.issued).toEqual([expect.objectContaining({
      sessionId: response.body.session.sessionId,
    })]);
  });

  it('preserves native app and daemon client kinds in server-side session metadata', async () => {
    const auth = createAuth({ grantId: 'grant_1', actorId: 'access:token_hash' });
    const providerTokenService = createProviderTokenService();
    const pool = createPool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter(), { auth, providerTokenService });

    const response = await request(app)
      .post('/api/docs/doc_1/branches/branch_1/collab/session')
      .send({ mode: 'edit', clientKind: 'daemon', displayName: 'Alice' })
      .expect(201);

    expect(response.body.session.clientKind).toBe('daemon');
    expect(pool.issuances[0]).toEqual(expect.arrayContaining(['daemon', 'user']));
  });

  it('does not let browser callers claim agent client kind', async () => {
    const auth = createAuth();
    const providerTokenService = createProviderTokenService();
    const pool = createPool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter(), { auth, providerTokenService });

    const response = await request(app)
      .post('/api/docs/doc_1/branches/branch_1/collab/session')
      .send({ mode: 'edit', clientKind: 'agent', displayName: 'Alice' })
      .expect(201);

    expect(response.body.session.clientKind).toBe('browser');
    expect(pool.issuances[0]).toEqual(expect.arrayContaining(['browser', 'user', `session:${response.body.session.sessionId}`, 'grant_1']));
  });

  it('mints edit provider tokens for server-verified logged-in users', async () => {
    const auth = createAuth({ grantId: null, actorId: 'user_1' });
    const providerTokenService = createProviderTokenService();
    const pool = createPool({ activeSessionActorGrantId: null, activeSessionActorId: 'user_1', activeSessionIsGuest: false });
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter(), { auth, providerTokenService });

    const response = await request(app)
      .post('/api/docs/doc_1/branches/branch_1/collab/session')
      .send({ mode: 'edit', clientKind: 'browser', displayName: 'Alice' })
      .expect(201);

    expect(response.body.providerToken.sessionIdentity).toEqual(expect.objectContaining({
      actorId: 'user_1',
      isGuest: false,
    }));
    expect(pool.collabSessions[0]?.[6]).toBe('user_1');
    expect(pool.issuances[0]).toEqual(expect.arrayContaining(['browser', 'user', 'user_1', null]));
    expect(providerTokenService.issued).toHaveLength(1);
  });

  it('ignores client-supplied actor ids and forged PermanentUserData attribution', async () => {
    const auth = createAuth({ grantId: null, actorId: 'user_1' });
    const providerTokenService = createProviderTokenService();
    const pool = createPool({ activeSessionActorGrantId: null, activeSessionActorId: 'user_1', activeSessionIsGuest: false });
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter(), { auth, providerTokenService });

    const response = await request(app)
      .post('/api/docs/doc_1/branches/branch_1/collab/session')
      .send({
        mode: 'edit',
        clientKind: 'browser',
        displayName: 'Alice',
        actorId: 'attacker_user',
        permanentUserData: { clientId: 123, userId: 'attacker_user' },
      })
      .expect(201);

    expect(response.body.providerToken.sessionIdentity).toEqual(expect.objectContaining({
      actorId: 'user_1',
      displayName: 'Alice',
      isGuest: false,
    }));
    expect(JSON.stringify(response.body)).not.toContain('attacker_user');
    expect(pool.collabSessions[0]?.[6]).toBe('user_1');
    expect(pool.issuances[0]).toEqual(expect.arrayContaining(['browser', 'user', 'user_1', null]));
  });

  it('does not return a direct-user provider token when write access is revoked while minting', async () => {
    let writeChecks = 0;
    const auth: HttpRequestAuth = {
      async requireAdminAccess() {},
      async requireDocumentAccess(_req, _docId, _branchId, operation) {
        if (operation === 'write') {
          writeChecks += 1;
          if (writeChecks > 1) throw new Error('forbidden');
        }
        return { actorType: 'user', actorId: 'user_1' };
      },
    };
    const providerTokenService = createProviderTokenService();
    const pool = createPool({ activeSessionActorGrantId: null, activeSessionActorId: 'user_1', activeSessionIsGuest: false });
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter(), { auth, providerTokenService });

    await request(app)
      .post('/api/docs/doc_1/branches/branch_1/collab/session')
      .send({ mode: 'edit', clientKind: 'browser', displayName: 'Alice' })
      .expect(403);

    expect(writeChecks).toBe(2);
    expect(providerTokenService.issued).toHaveLength(1);
    expect(pool.statusUpdates).toContainEqual(['issuance_1', 'failed', 'provider_token_issue_failed']);
    expect(pool.collabSessionFailures).toHaveLength(1);
  });

  it('records guest edit sessions distinctly for share-link quota enforcement', async () => {
    const auth = createAuth({ grantId: 'grant_1', actorId: 'share:token_hash' });
    const providerTokenService = createProviderTokenService();
    const pool = createPool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter(), { auth, providerTokenService });

    const response = await request(app)
      .post('/api/docs/doc_1/branches/branch_1/collab/session')
      .send({ mode: 'edit', clientKind: 'browser', displayName: 'Guest' })
      .expect(201);

    expect(response.body.session.clientKind).toBe('browser');
    expect(response.body.session.refreshToken).toEqual(expect.any(String));
    expect(pool.collabSessions[0]).toEqual(expect.arrayContaining([
      response.body.session.sessionId,
      'doc_1',
      'branch_1',
      'edit',
      'browser',
      'user',
      `session:${response.body.session.sessionId}`,
      'grant_1',
      'edit',
      'Guest',
    ]));
    expect(pool.collabSessions[0]?.[9]).toBe(true);
    expect(pool.issuances[0]).toEqual(expect.arrayContaining([
      'browser',
      'user',
      `session:${response.body.session.sessionId}`,
      'grant_1',
    ]));
  });

  it('honors explicit share-link query tokens even when a logged-in user is not a workspace member', async () => {
    process.env.MARKLAB_REQUIRE_AUTH = 'true';
    const shareToken = generateShareToken();
    const providerTokenService = createProviderTokenService();
    const pool = createPool({
      documentAccessGrantTokenHash: hashToken(shareToken),
      documentAccessGrantRole: 'edit',
    });
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter(), { providerTokenService });

    const response = await request(app)
      .post(`/api/docs/doc_1/branches/branch_1/collab/session?token=${encodeURIComponent(shareToken)}`)
      .set('Cookie', 'marklab_session=reader-token')
      .send({ mode: 'edit', clientKind: 'browser', displayName: 'Guest' })
      .expect(201);

    expect(pool.collabSessions[0]).toEqual(expect.arrayContaining([
      response.body.session.sessionId,
      'doc_1',
      'branch_1',
      'edit',
      'browser',
      'user',
      `session:${response.body.session.sessionId}`,
      'share_grant_1',
      'edit',
      'Guest',
    ]));
    expect(pool.collabSessions[0]?.[9]).toBe(true);
    expect(pool.issuances[0]).toEqual(expect.arrayContaining([
      'browser',
      'user',
      `session:${response.body.session.sessionId}`,
      'share_grant_1',
    ]));
    expect(response.body.providerToken.sessionIdentity).toEqual(expect.objectContaining({
      actorId: `session:${response.body.session.sessionId}`,
      isGuest: true,
    }));
  });

  it('prefers a logged-in workspace member over an explicit share-link token', async () => {
    process.env.MARKLAB_REQUIRE_AUTH = 'true';
    const shareToken = generateShareToken();
    const providerTokenService = createProviderTokenService();
    const pool = createPool({
      documentAccessGrantTokenHash: hashToken(shareToken),
      documentAccessGrantRole: 'edit',
      readerMemberRole: 'Member',
    });
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter(), { providerTokenService });

    const response = await request(app)
      .post(`/api/docs/doc_1/branches/branch_1/collab/session?token=${encodeURIComponent(shareToken)}`)
      .set('Cookie', 'marklab_session=reader-token')
      .send({ mode: 'edit', clientKind: 'browser', displayName: 'Named Member' })
      .expect(201);

    expect(pool.collabSessions[0]).toEqual(expect.arrayContaining([
      response.body.session.sessionId,
      'doc_1',
      'branch_1',
      'edit',
      'browser',
      'user',
      'user_reader',
      null,
      'edit',
      'Named Member',
    ]));
    expect(pool.collabSessions[0]?.[9]).toBe(false);
    expect(pool.issuances[0]).toEqual(expect.arrayContaining([
      'browser',
      'user',
      'user_reader',
      null,
    ]));
    expect(response.body.providerToken.sessionIdentity).toEqual(expect.objectContaining({
      actorId: 'user_reader',
      isGuest: false,
    }));

    const bearerPool = createPool({
      documentAccessGrantTokenHash: hashToken(shareToken),
      documentAccessGrantRole: 'edit',
      readerMemberRole: 'Member',
    });
    const bearerProviderTokenService = createProviderTokenService();
    const bearerApp = createHttpApp(bearerPool, createUnavailableLiveMarkdownWriter(), { providerTokenService: bearerProviderTokenService });

    const bearerResponse = await request(bearerApp)
      .post('/api/docs/doc_1/branches/branch_1/collab/session')
      .set({
        Authorization: `Bearer ${shareToken}`,
        Cookie: 'marklab_session=reader-token',
      })
      .send({ mode: 'edit', clientKind: 'browser', displayName: 'Bearer Member' })
      .expect(201);

    expect(bearerPool.collabSessions[0]).toEqual(expect.arrayContaining([
      bearerResponse.body.session.sessionId,
      'doc_1',
      'branch_1',
      'edit',
      'browser',
      'user',
      'user_reader',
      null,
      'edit',
      'Bearer Member',
    ]));
    expect(bearerPool.collabSessions[0]?.[9]).toBe(false);
  });

  it('does not let a logged-in Reader use an explicit edit link to bypass workspace role', async () => {
    process.env.MARKLAB_REQUIRE_AUTH = 'true';
    const shareToken = generateShareToken();
    const providerTokenService = createProviderTokenService();
    const pool = createPool({
      documentAccessGrantTokenHash: hashToken(shareToken),
      documentAccessGrantRole: 'edit',
      readerMemberRole: 'Reader',
    });
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter(), { providerTokenService });

    await request(app)
      .post(`/api/docs/doc_1/branches/branch_1/collab/session?token=${encodeURIComponent(shareToken)}`)
      .set('Cookie', 'marklab_session=reader-token')
      .send({ mode: 'edit', clientKind: 'browser', displayName: 'Reader' })
      .expect(403, { error: 'forbidden' });

    expect(pool.collabSessions).toEqual([]);
    expect(providerTokenService.issued).toEqual([]);
  });

  it('retries provider document seeding after a transient initial seed failure', async () => {
    const auth = createAuth();
    const providerTokenService = createProviderTokenService({ failFirstIssue: true });
    const pool = createPool({ initialProviderDocId: null });
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter(), { auth, providerTokenService });

    await request(app)
      .post('/api/docs/doc_1/branches/branch_1/collab/session')
      .send({ mode: 'edit', clientKind: 'browser', displayName: 'Alice' })
      .expect(500);

    await request(app)
      .post('/api/docs/doc_1/branches/branch_1/collab/session')
      .send({ mode: 'edit', clientKind: 'browser', displayName: 'Alice' })
      .expect(201);

    const firstIssue = providerTokenService.issued[0] as { providerDocId: string };
    expect(providerTokenService.issued).toEqual([
      expect.objectContaining({ seedYjsState: new Uint8Array([1, 2, 3]) }),
      expect.objectContaining({ seedYjsState: new Uint8Array([1, 2, 3]) }),
    ]);
    expect(providerTokenService.issued[1]).toEqual(expect.objectContaining({
      providerDocId: firstIssue.providerDocId,
    }));
    expect(pool.providerDocSeedMarks).toHaveLength(1);
  });

  it('retries provider document seeding after the seeded marker fails to persist', async () => {
    const auth = createAuth();
    const providerTokenService = createProviderTokenService();
    const pool = createPool({ initialProviderDocId: null, failSeedMarkOnce: true });
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter(), { auth, providerTokenService });

    await request(app)
      .post('/api/docs/doc_1/branches/branch_1/collab/session')
      .send({ mode: 'edit', clientKind: 'browser', displayName: 'Alice' })
      .expect(500);

    await request(app)
      .post('/api/docs/doc_1/branches/branch_1/collab/session')
      .send({ mode: 'edit', clientKind: 'browser', displayName: 'Alice' })
      .expect(201);

    expect(providerTokenService.issued).toHaveLength(2);
    expect(providerTokenService.issued).toEqual([
      expect.objectContaining({ seedYjsState: new Uint8Array([1, 2, 3]) }),
      expect.objectContaining({ seedYjsState: new Uint8Array([1, 2, 3]) }),
    ]);
    expect(pool.providerDocSeedMarks).toHaveLength(1);
  });

  it('skips provider document seeding when another first edit session wins the seed lock', async () => {
    const auth = createAuth();
    const providerTokenService = createProviderTokenService();
    const pool = createPool({
      initialProviderDocSeededAt: null,
      providerDocSeededBeforeTokenIssue: true,
    });
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter(), { auth, providerTokenService });

    await request(app)
      .post('/api/docs/doc_1/branches/branch_1/collab/session')
      .send({ mode: 'edit', clientKind: 'browser', displayName: 'Alice' })
      .expect(201);

    expect(pool.providerDocSeedLocks).toContainEqual(['provider_doc_seed:doc_1:branch_1']);
    expect(pool.providerDocSeedReads).toEqual([['branch_1', 'doc_1', 'ml_doc_existing']]);
    expect(providerTokenService.issued).toHaveLength(1);
    expect(providerTokenService.issued[0]).toEqual(expect.not.objectContaining({
      seedYjsState: expect.anything(),
    }));
    expect(pool.providerDocSeedMarks).toEqual([]);
  });

  it('denies guest edit token minting when the branch guest quota is exhausted', async () => {
    const auth = createAuth({ grantId: 'grant_1', actorId: 'share:token_hash' });
    const providerTokenService = createProviderTokenService();
    const pool = createPool({ activeGuestSessions: 3 });
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter(), { auth, providerTokenService });

    await request(app)
      .post('/api/docs/doc_1/branches/branch_1/collab/session')
      .send({ mode: 'edit', clientKind: 'browser', displayName: 'Guest' })
      .expect(429);

    expect(providerTokenService.issued).toEqual([]);
    expect(pool.issuances).toEqual([]);
  });

  it('charges access-grant bearer edit sessions against guest quota', async () => {
    const auth = createAuth({ grantId: 'grant_1', actorId: 'access:token_hash' });
    const providerTokenService = createProviderTokenService();
    const pool = createPool({ activeGuestSessions: 3 });
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter(), { auth, providerTokenService });

    await request(app)
      .post('/api/docs/doc_1/branches/branch_1/collab/session')
      .send({ mode: 'edit', clientKind: 'browser', displayName: 'Member' })
      .expect(429);

    expect(providerTokenService.issued).toEqual([]);
    expect(pool.issuances).toEqual([]);
  });

  it('does not return an initial edit provider token when the grant is revoked while the provider token is minting', async () => {
    const auth = createAuth();
    const providerTokenService = createProviderTokenService();
    const pool = createPool({ revokeDuringRefresh: true, providerPolicyDenyReason: 'grant_revoked' });
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter(), { auth, providerTokenService });

    await request(app)
      .post('/api/docs/doc_1/branches/branch_1/collab/session')
      .send({ mode: 'edit', clientKind: 'browser', displayName: 'Guest' })
      .expect(403, { error: 'grant_revoked' });

    expect(providerTokenService.issued).toHaveLength(0);
    expect(pool.statusUpdates[0]).toEqual(['issuance_1', 'failed', 'provider_token_issue_failed']);
    expect(pool.collabSessionFailures).toHaveLength(1);
  });

  it('does not mint edit provider tokens when auth returns no verified actor', async () => {
    const operations: string[] = [];
    const auth: HttpRequestAuth = {
      async requireAdminAccess() {},
      async requireDocumentAccess(_req, _docId, _branchId, operation) {
        operations.push(operation);
        return undefined;
      },
    };
    const providerTokenService = createProviderTokenService();
    const app = createHttpApp(createPool(), createUnavailableLiveMarkdownWriter(), { auth, providerTokenService });

    await request(app)
      .post('/api/docs/doc_1/branches/branch_1/collab/session')
      .send({ mode: 'edit', clientKind: 'browser', displayName: 'Alice' })
      .expect(403);

    expect(operations).toEqual(['write']);
    expect(providerTokenService.issued).toEqual([]);
  });

  it('does not mint edit provider tokens when auth returns only an actor type', async () => {
    const operations: string[] = [];
    const auth: HttpRequestAuth = {
      async requireAdminAccess() {},
      async requireDocumentAccess(_req, _docId, _branchId, operation) {
        operations.push(operation);
        return { actorType: 'user' };
      },
    };
    const providerTokenService = createProviderTokenService();
    const app = createHttpApp(createPool(), createUnavailableLiveMarkdownWriter(), { auth, providerTokenService });

    await request(app)
      .post('/api/docs/doc_1/branches/branch_1/collab/session')
      .send({ mode: 'edit', clientKind: 'browser', displayName: 'Alice' })
      .expect(403);

    expect(operations).toEqual(['write']);
    expect(providerTokenService.issued).toEqual([]);
  });

  it('does not mint edit provider tokens when a grant has no server-derived actor id', async () => {
    const auth = createAuth({ grantId: 'grant_1', actorId: null });
    const providerTokenService = createProviderTokenService();
    const app = createHttpApp(createPool(), createUnavailableLiveMarkdownWriter(), { auth, providerTokenService });

    await request(app)
      .post('/api/docs/doc_1/branches/branch_1/collab/session')
      .send({ mode: 'edit', clientKind: 'browser', displayName: 'Guest' })
      .expect(403);

    expect(providerTokenService.issued).toEqual([]);
  });

  it('does not let the dev-anonymous escape hatch mint edit tokens for missing actor identity', async () => {
    process.env.MARKLAB_ENABLE_DEV_ANONYMOUS_COLLAB = 'true';
    const operations: string[] = [];
    const auth: HttpRequestAuth = {
      async requireAdminAccess() {},
      async requireDocumentAccess(_req, _docId, _branchId, operation) {
        operations.push(operation);
        return { actorType: 'user' };
      },
    };
    const providerTokenService = createProviderTokenService();
    const app = createHttpApp(createPool(), createUnavailableLiveMarkdownWriter(), { auth, providerTokenService });

    await request(app)
      .post('/api/docs/doc_1/branches/branch_1/collab/session')
      .send({ mode: 'edit', clientKind: 'browser', displayName: 'Dev' })
      .expect(403);

    expect(operations).toEqual(['write']);
    expect(providerTokenService.issued).toEqual([]);
  });

  it('does not mint edit provider tokens through implicit dev-anonymous auth by default', async () => {
    process.env.MARKLAB_REQUIRE_AUTH = 'false';
    delete process.env.MARKLAB_ENABLE_DEV_ANONYMOUS_COLLAB;
    const providerTokenService = createProviderTokenService();
    const app = createHttpApp(createPool(), createUnavailableLiveMarkdownWriter(), { providerTokenService });

    await request(app)
      .post('/api/docs/doc_1/branches/branch_1/collab/session')
      .send({ mode: 'edit', clientKind: 'browser', displayName: 'Dev' })
      .expect(403);

    expect(providerTokenService.issued).toEqual([]);
  });

  it('requires explicit opt-in before dev-anonymous smoke tests can mint edit provider tokens', async () => {
    process.env.MARKLAB_REQUIRE_AUTH = 'false';
    process.env.MARKLAB_ENABLE_DEV_ANONYMOUS_COLLAB = 'true';
    const providerTokenService = createProviderTokenService();
    const pool = createPool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter(), { providerTokenService });

    const response = await request(app)
      .post('/api/docs/doc_1/branches/branch_1/collab/session')
      .send({ mode: 'edit', clientKind: 'browser', displayName: 'Dev' })
      .expect(201);

    expect(response.body.session.sessionId).toMatch(/^session_[0-9a-f-]{36}$/u);
    expect(pool.issuances[0]).toEqual(expect.arrayContaining(['browser', 'user', 'dev-anonymous']));
  });

  it('returns a public view snapshot without provider credentials', async () => {
    const auth = createAuth();
    const providerTokenService = createProviderTokenService();
    const flushCollabDocument = vi.fn(async () => undefined);
    const pool = createPool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter(), { auth, providerTokenService, flushCollabDocument });

    const response = await request(app)
      .post('/api/docs/doc_1/branches/branch_1/collab/session')
      .send({ mode: 'view', clientKind: 'guest', displayName: 'Guest' })
      .expect(200);

    expect(auth.operations).toEqual(['read']);
    expect(flushCollabDocument).toHaveBeenCalledWith('doc:doc_1:branch:branch_1');
    expect(providerTokenService.issued).toEqual([]);
    expect(response.body).toMatchObject({
      mode: 'view',
      session: {
        clientKind: 'browser',
        displayName: 'Guest',
      },
      document: {
        markdown: '# Visible\n',
        hash: 'sha256:markdown',
      },
    });
    expect(response.body.session.sessionId).toMatch(/^session_[0-9a-f-]{36}$/u);
    expect(pool.collabSessions[0]).toEqual(expect.arrayContaining([
      response.body.session.sessionId,
      'doc_1',
      'branch_1',
      'view',
      'browser',
      'user',
      `session:${response.body.session.sessionId}`,
      'grant_1',
      'view',
      'Guest',
    ]));
    expect(pool.documentAccessSessions[0]).toEqual([
      'grant_1',
      'doc_1',
      'branch_1',
      response.body.session.sessionId,
      'browser',
      'guest',
      `session:${response.body.session.sessionId}`,
      'Guest',
      expect.stringMatching(/^#[0-9a-f]{6}$/u),
      'branch_1',
    ]);
    expect(response.body.providerToken).toBeUndefined();
  });

  it('records direct logged-in view sessions in document access audit rows', async () => {
    process.env.MARKLAB_REQUIRE_AUTH = 'true';
    const providerTokenService = createProviderTokenService();
    const flushCollabDocument = vi.fn(async () => undefined);
    const pool = createPool({ readerMemberRole: 'Reader' });
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter(), { providerTokenService, flushCollabDocument });

    const response = await request(app)
      .post('/api/docs/doc_1/branches/branch_1/collab/session')
      .set('Cookie', 'marklab_session=reader-token')
      .send({ mode: 'view', clientKind: 'daemon', displayName: 'Reader' })
      .expect(200);

    expect(pool.collabSessions[0]).toEqual(expect.arrayContaining([
      response.body.session.sessionId,
      'doc_1',
      'branch_1',
      'view',
      'daemon',
      'user',
      'user_reader',
      null,
      'view',
      'Reader',
    ]));
    expect(pool.documentAccessSessions[0]).toEqual([
      null,
      'doc_1',
      'branch_1',
      response.body.session.sessionId,
      'daemon',
      'user',
      'user_reader',
      'Reader',
      expect.stringMatching(/^#[0-9a-f]{6}$/u),
      'branch_1',
    ]);
  });

  it('serves migrated legacy share-link view sessions through document access grants', async () => {
    process.env.MARKLAB_REQUIRE_AUTH = 'true';
    const migratedShareToken = generateShareToken();
    const providerTokenService = createProviderTokenService();
    const flushCollabDocument = vi.fn(async () => undefined);
    const pool = createPool({
      documentAccessGrantTokenHash: hashToken(migratedShareToken),
      documentAccessGrantRole: 'view',
    });
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter(), { providerTokenService, flushCollabDocument });

    const response = await request(app)
      .post(`/api/docs/doc_1/branches/branch_1/collab/session?token=${encodeURIComponent(migratedShareToken)}`)
      .send({ mode: 'view', clientKind: 'guest', displayName: 'Legacy Guest' })
      .expect(200);

    expect(response.body.providerToken).toBeUndefined();
    expect(response.body.document.markdown).toBe('# Visible\n');
    expect(pool.collabSessions[0]).toEqual(expect.arrayContaining([
      response.body.session.sessionId,
      'doc_1',
      'branch_1',
      'view',
      'browser',
      'user',
      `session:${response.body.session.sessionId}`,
      'share_grant_1',
      'view',
      'Legacy Guest',
    ]));
    expect(pool.documentAccessSessions[0]).toEqual([
      'share_grant_1',
      'doc_1',
      'branch_1',
      response.body.session.sessionId,
      'browser',
      'guest',
      `session:${response.body.session.sessionId}`,
      'Legacy Guest',
      expect.stringMatching(/^#[0-9a-f]{6}$/u),
      'branch_1',
    ]);
  });

  it('blocks revoked view grants before reading a snapshot', async () => {
    process.env.MARKLAB_REQUIRE_AUTH = 'true';
    const accessToken = generateAccessToken();
    const providerTokenService = createProviderTokenService();
    const flushCollabDocument = vi.fn(async () => undefined);
    const pool = createPool({
      documentAccessGrantTokenHash: hashToken(accessToken),
      documentAccessGrantRole: 'view',
      documentAccessGrantRevoked: true,
    });
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter(), { providerTokenService, flushCollabDocument });

    await request(app)
      .post(`/api/docs/doc_1/branches/branch_1/collab/session?token=${encodeURIComponent(accessToken)}`)
      .send({ mode: 'view', clientKind: 'guest', displayName: 'Guest' })
      .expect(403);

    expect(flushCollabDocument).not.toHaveBeenCalled();
    expect(pool.collabSessions).toEqual([]);
    expect(providerTokenService.issued).toEqual([]);
  });

  it('does not let requested view client kind forge document access audit actor kind', async () => {
    const auth = createAuth({ grantId: 'grant_1', actorId: 'access:token_hash' });
    const providerTokenService = createProviderTokenService();
    const flushCollabDocument = vi.fn(async () => undefined);
    const pool = createPool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter(), { auth, providerTokenService, flushCollabDocument });

    const response = await request(app)
      .post('/api/docs/doc_1/branches/branch_1/collab/session')
      .send({ mode: 'view', clientKind: 'daemon', displayName: 'User' })
      .expect(200);

    expect(response.body.session.clientKind).toBe('daemon');
    expect(pool.documentAccessSessions[0]).toEqual([
      'grant_1',
      'doc_1',
      'branch_1',
      response.body.session.sessionId,
      'daemon',
      'guest',
      `session:${response.body.session.sessionId}`,
      'User',
      expect.stringMatching(/^#[0-9a-f]{6}$/u),
      'branch_1',
    ]);
  });

  it('does not read or flush a view snapshot when auth returns no verified actor', async () => {
    const operations: string[] = [];
    const auth: HttpRequestAuth = {
      async requireAdminAccess() {},
      async requireDocumentAccess(_req, _docId, _branchId, operation) {
        operations.push(operation);
        return undefined;
      },
    };
    const providerTokenService = createProviderTokenService();
    const flushCollabDocument = vi.fn(async () => undefined);
    const app = createHttpApp(createPool(), createUnavailableLiveMarkdownWriter(), { auth, providerTokenService, flushCollabDocument });

    await request(app)
      .post('/api/docs/doc_1/branches/branch_1/collab/session')
      .send({ mode: 'view', clientKind: 'guest', displayName: 'Guest' })
      .expect(403);

    expect(operations).toEqual(['read']);
    expect(flushCollabDocument).not.toHaveBeenCalled();
    expect(providerTokenService.issued).toEqual([]);
  });

  it('falls back to the stored control-plane snapshot when a live provider document does not exist yet', async () => {
    const auth = createAuth();
    const providerTokenService = createProviderTokenService();
    const app = createHttpApp(createPool(), createUnavailableLiveMarkdownWriter(), {
      auth,
      providerTokenService,
      collabSnapshotService: {
        async readCurrentMarkdownSnapshot() {
          return null;
        },
      },
    });

    await request(app)
      .post('/api/docs/doc_1/branches/branch_1/collab/session')
      .send({ mode: 'view', clientKind: 'guest', displayName: 'Guest' })
      .expect(200);

    expect(providerTokenService.issued).toEqual([]);
  });

  it('fails closed when a configured live view snapshot throws unavailable', async () => {
    const auth = createAuth();
    const providerTokenService = createProviderTokenService();
    const app = createHttpApp(createPool(), createUnavailableLiveMarkdownWriter(), {
      auth,
      providerTokenService,
      collabSnapshotService: {
        async readCurrentMarkdownSnapshot() {
          throw new Error('collab_snapshot_unavailable');
        },
      },
    });

    await request(app)
      .post('/api/docs/doc_1/branches/branch_1/collab/session')
      .send({ mode: 'view', clientKind: 'guest', displayName: 'Guest' })
      .expect(503);

    expect(providerTokenService.issued).toEqual([]);
  });

  it('does not read or flush a view snapshot when read access is denied', async () => {
    const auth = createAuth({ denyRead: true });
    const providerTokenService = createProviderTokenService();
    const flushCollabDocument = vi.fn(async () => undefined);
    const app = createHttpApp(createPool(), createUnavailableLiveMarkdownWriter(), { auth, providerTokenService, flushCollabDocument });

    await request(app)
      .post('/api/docs/doc_1/branches/branch_1/collab/session')
      .send({ mode: 'view', clientKind: 'guest', displayName: 'Guest' })
      .expect(403);

    expect(auth.operations).toEqual(['read']);
    expect(flushCollabDocument).not.toHaveBeenCalled();
    expect(providerTokenService.issued).toEqual([]);
  });

  it('fails closed when view mode has no current-state snapshot path', async () => {
    const auth = createAuth();
    const providerTokenService = createProviderTokenService();
    const app = createHttpApp(createPool(), createUnavailableLiveMarkdownWriter(), { auth, providerTokenService });

    await request(app)
      .post('/api/docs/doc_1/branches/branch_1/collab/session')
      .send({ mode: 'view', clientKind: 'guest', displayName: 'Guest' })
      .expect(503);

    expect(providerTokenService.issued).toEqual([]);
  });

  it('fails closed when the flushed fallback view snapshot is missing', async () => {
    const auth = createAuth();
    const providerTokenService = createProviderTokenService();
    const flushCollabDocument = vi.fn(async () => undefined);
    const app = createHttpApp(
      createPool({ missingBranchState: true }),
      createUnavailableLiveMarkdownWriter(),
      { auth, providerTokenService, flushCollabDocument },
    );

    await request(app)
      .post('/api/docs/doc_1/branches/branch_1/collab/session')
      .send({ mode: 'view', clientKind: 'guest', displayName: 'Guest' })
      .expect(503);

    expect(flushCollabDocument).toHaveBeenCalledWith('doc:doc_1:branch:branch_1');
    expect(providerTokenService.issued).toEqual([]);
  });

  it('uses a live current-state snapshot for public view sessions when available', async () => {
    const auth = createAuth();
    const providerTokenService = createProviderTokenService();
    const app = createHttpApp(createPool(), createUnavailableLiveMarkdownWriter(), {
      auth,
      providerTokenService,
      collabSnapshotService: {
        async readCurrentMarkdownSnapshot() {
          return {
            docId: 'doc_1',
            branchId: 'branch_1',
            versionId: null,
            versionNumber: null,
            hash: 'sha256:live',
            markdown: '# Live provider snapshot\n',
          };
        },
      },
    });

    const response = await request(app)
      .post('/api/docs/doc_1/branches/branch_1/collab/session')
      .send({ mode: 'view', clientKind: 'guest', displayName: 'Guest' })
      .expect(200);

    expect(providerTokenService.issued).toEqual([]);
    expect(response.body.document).toMatchObject({
      hash: 'sha256:live',
      markdown: '# Live provider snapshot\n',
    });
    expect(response.body.providerToken).toBeUndefined();
  });

  it('refreshes an existing guest edit provider token without resending the raw share token', async () => {
    const auth = createAuth();
    const providerTokenService = createProviderTokenService();
    const pool = createPool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter(), { auth, providerTokenService });

    const response = await request(app)
      .post('/api/docs/doc_1/branches/branch_1/collab/session/session_server/provider-token/refresh')
      .send({ refreshToken: serverSessionRefreshToken, clientKind: 'guest' })
      .expect(200);

    expect(auth.operations).toEqual([]);
    expect(providerTokenService.issued).toEqual([expect.objectContaining({
      providerDocId: 'ml_doc_existing',
      sessionId: 'session_server',
      authorization: 'full',
      validForSeconds: PROVIDER_TOKEN_TTL_SECONDS,
      sessionIdentity: expect.objectContaining({
        sessionId: 'session_server',
        actorType: 'user',
        actorId: 'session:session_server',
        displayName: 'Guest',
        isGuest: true,
      }),
    })]);
    expect(response.body.providerToken.clientToken.authorization).toBe('full');
    expect(response.body.providerToken.validForSeconds).toBe(PROVIDER_TOKEN_TTL_SECONDS);
    expect(pool.issuances[0]).toEqual(expect.arrayContaining([
      'guest',
      'user',
      'session:session_server',
      'grant_1',
      'full',
      PROVIDER_TOKEN_TTL_SECONDS,
      'pending',
    ]));
    expect(pool.statusUpdates[0]).toEqual(['issuance_1', 'doc_1', 'branch_1', 'session_server']);
    expect(pool.collabSessionTouches[0]).toEqual(['session_server', 'doc_1', 'branch_1', 'guest']);
    expect(pool.refreshAttempts[0]).toEqual(['session_server']);
    expect(pool.refreshIssued[0]).toEqual(['refresh_1', response.body.providerToken.expiresAt, 'issuance_1']);
  });

  it('refreshes an existing guest edit session even when the guest quota is full', async () => {
    const auth = createAuth({ grantId: 'grant_1', actorId: 'share:token_hash' });
    const providerTokenService = createProviderTokenService();
    const pool = createPool({ activeGuestSessions: 3 });
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter(), { auth, providerTokenService });

    await request(app)
      .post('/api/docs/doc_1/branches/branch_1/collab/session/session_server/provider-token/refresh')
      .send({ refreshToken: serverSessionRefreshToken })
      .expect(200);

    expect(providerTokenService.issued).toEqual([expect.objectContaining({
      providerDocId: 'ml_doc_existing',
      sessionId: 'session_server',
      sessionIdentity: expect.objectContaining({
        actorId: 'session:session_server',
        isGuest: true,
      }),
    })]);
    expect(pool.issuances).toHaveLength(1);
    expect(pool.refreshIssued).toHaveLength(1);
  });

  it('refreshes a guest session under auth-required mode using only the session refresh token', async () => {
    process.env.MARKLAB_REQUIRE_AUTH = 'true';
    const providerTokenService = createProviderTokenService();
    const pool = createPool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter(), { providerTokenService });

    await request(app)
      .post('/api/docs/doc_1/branches/branch_1/collab/session/session_server/provider-token/refresh')
      .send({ refreshToken: serverSessionRefreshToken })
      .expect(200);

    expect(providerTokenService.issued).toEqual([expect.objectContaining({
      sessionIdentity: expect.objectContaining({
        actorId: 'session:session_server',
        isGuest: true,
      }),
    })]);
    expect(pool.refreshIssued).toHaveLength(1);
  });

  it('refreshes access-grant bearer edit sessions as existing guests with stable session identity', async () => {
    const auth = createAuth({ grantId: 'grant_1', actorId: 'access:token_hash' });
    const providerTokenService = createProviderTokenService();
    const pool = createPool({
      activeSessionActorGrantId: 'grant_1',
      activeSessionActorId: 'session:session_server',
      activeSessionClientKind: 'browser',
      activeSessionIsGuest: true,
    });
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter(), { auth, providerTokenService });

    await request(app)
      .post('/api/docs/doc_1/branches/branch_1/collab/session/session_server/provider-token/refresh')
      .send({ refreshToken: serverSessionRefreshToken })
      .expect(200);

    expect(providerTokenService.issued).toEqual([expect.objectContaining({
      providerDocId: 'ml_doc_existing',
      sessionId: 'session_server',
      authorization: 'full',
      validForSeconds: PROVIDER_TOKEN_TTL_SECONDS,
      sessionIdentity: expect.objectContaining({
        actorId: 'session:session_server',
        displayName: 'Guest',
        isGuest: true,
      }),
    })]);
    expect(pool.issuances[0]).toEqual(expect.arrayContaining([
      'browser',
      'user',
      'session:session_server',
      'grant_1',
    ]));
  });

  it('does not refresh a guest edit session when the current logged-in user is only a Reader', async () => {
    const auth = createAuth({ denyWrite: true, grantId: null, actorId: 'user_reader' });
    const providerTokenService = createProviderTokenService();
    const pool = createPool({
      activeSessionActorGrantId: 'grant_1',
      activeSessionActorId: 'session:session_server',
      activeSessionClientKind: 'browser',
      activeSessionIsGuest: true,
    });
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter(), { auth, providerTokenService });

    await request(app)
      .post('/api/docs/doc_1/branches/branch_1/collab/session/session_server/provider-token/refresh')
      .set('Cookie', 'marklab_session=reader-token')
      .send({ refreshToken: serverSessionRefreshToken })
      .expect(403, { error: 'forbidden' });

    expect(auth.operations).toEqual(['write', 'read']);
    expect(providerTokenService.issued).toHaveLength(0);
    expect(pool.refreshDenied[0]).toEqual(['refresh_1', 'forbidden']);
  });

  it('refreshes server-verified logged-in user edit sessions', async () => {
    const auth = createAuth({ grantId: null, actorId: 'user_1' });
    const providerTokenService = createProviderTokenService();
    const pool = createPool({
      activeSessionActorGrantId: null,
      activeSessionActorId: 'user_1',
      activeSessionClientKind: 'browser',
      activeSessionIsGuest: false,
    });
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter(), { auth, providerTokenService });

    await request(app)
      .post('/api/docs/doc_1/branches/branch_1/collab/session/session_server/provider-token/refresh')
      .send({ refreshToken: serverSessionRefreshToken })
      .expect(200);

    expect(auth.operations).toEqual(['write', 'write']);
    expect(providerTokenService.issued).toEqual([expect.objectContaining({
      sessionIdentity: expect.objectContaining({
        actorId: 'user_1',
        isGuest: false,
      }),
    })]);
    expect(pool.issuances[0]).toEqual(expect.arrayContaining(['browser', 'user', 'user_1', null]));
  });

  it('does not return a direct-user refreshed token when write access is revoked while minting', async () => {
    let writeChecks = 0;
    const auth: HttpRequestAuth = {
      async requireAdminAccess() {},
      async requireDocumentAccess(_req, _docId, _branchId, operation) {
        if (operation === 'write') {
          writeChecks += 1;
          if (writeChecks > 1) throw new Error('forbidden');
        }
        return { actorType: 'user', actorId: 'user_1' };
      },
    };
    const providerTokenService = createProviderTokenService();
    const pool = createPool({
      activeSessionActorGrantId: null,
      activeSessionActorId: 'user_1',
      activeSessionClientKind: 'browser',
      activeSessionIsGuest: false,
    });
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter(), { auth, providerTokenService });

    await request(app)
      .post('/api/docs/doc_1/branches/branch_1/collab/session/session_server/provider-token/refresh')
      .send({ refreshToken: serverSessionRefreshToken })
      .expect(403);

    expect(writeChecks).toBe(2);
    expect(providerTokenService.issued).toHaveLength(1);
    expect(pool.statusUpdates).toContainEqual(['issuance_1', 'failed', 'provider_token_issue_failed']);
  });

  it('does not return a direct-user refreshed token when workspace role is revoked after the final auth check', async () => {
    const auth = createAuth({ grantId: null, actorId: 'user_1' });
    const providerTokenService = createProviderTokenService();
    const pool = createPool({
      activeSessionActorGrantId: null,
      activeSessionActorId: 'user_1',
      activeSessionClientKind: 'browser',
      activeSessionIsGuest: false,
      deleteBeforeMarkIssued: true,
      providerPolicyDenyReason: 'forbidden',
    });
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter(), { auth, providerTokenService });

    await request(app)
      .post('/api/docs/doc_1/branches/branch_1/collab/session/session_server/provider-token/refresh')
      .send({ refreshToken: serverSessionRefreshToken })
      .expect(403, { error: 'forbidden' });

    expect(auth.operations).toEqual(['write', 'write']);
    expect(providerTokenService.issued).toHaveLength(1);
    expect(pool.refreshDenied[0]).toEqual(['refresh_1', 'forbidden']);
    expect(pool.statusUpdates).toContainEqual(['issuance_1', 'failed', 'provider_token_issue_failed']);
  });

  it('does not refresh a grant-backed session with only the leaked session id', async () => {
    const auth = createAuth();
    const providerTokenService = createProviderTokenService();
    const app = createHttpApp(createPool(), createUnavailableLiveMarkdownWriter(), { auth, providerTokenService });

    await request(app)
      .post('/api/docs/doc_1/branches/branch_1/collab/session/session_server/provider-token/refresh')
      .send({})
      .expect(400);

    expect(providerTokenService.issued).toEqual([]);
  });

  it('does not refresh a grant-backed session with the wrong session refresh token', async () => {
    const auth = createAuth();
    const providerTokenService = createProviderTokenService();
    const pool = createPool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter(), { auth, providerTokenService });

    await request(app)
      .post('/api/docs/doc_1/branches/branch_1/collab/session/session_server/provider-token/refresh')
      .send({ refreshToken: 'wrong_refresh_token_012345678901234567890' })
      .expect(404);

    expect(providerTokenService.issued).toEqual([]);
    expect(pool.refreshAttempts).toEqual([]);
    expect(pool.refreshDenied).toEqual([]);
  });

  it('reports revoked edit grants explicitly when refresh is denied before provider token minting', async () => {
    const auth = createAuth();
    const providerTokenService = createProviderTokenService();
    const pool = createPool({ documentAccessGrantRevoked: true });
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter(), { auth, providerTokenService });

    await request(app)
      .post('/api/docs/doc_1/branches/branch_1/collab/session/session_server/provider-token/refresh')
      .send({ refreshToken: serverSessionRefreshToken })
      .expect(403, { error: 'grant_revoked' });

    expect(providerTokenService.issued).toHaveLength(0);
    expect(pool.issuances).toEqual([]);
    expect(pool.statusUpdates).toEqual([]);
    expect(pool.collabSessionTouches).toEqual([]);
    expect(pool.refreshDenied[0]).toEqual(['refresh_1', 'grant_revoked']);
  });

  it('reports expired edit grants explicitly when refresh is denied before provider token minting', async () => {
    const auth = createAuth();
    const providerTokenService = createProviderTokenService();
    const pool = createPool({ documentAccessGrantExpired: true });
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter(), { auth, providerTokenService });

    await request(app)
      .post('/api/docs/doc_1/branches/branch_1/collab/session/session_server/provider-token/refresh')
      .send({ refreshToken: serverSessionRefreshToken })
      .expect(403, { error: 'grant_expired' });

    expect(providerTokenService.issued).toHaveLength(0);
    expect(pool.issuances).toEqual([]);
    expect(pool.statusUpdates).toEqual([]);
    expect(pool.collabSessionTouches).toEqual([]);
    expect(pool.refreshDenied[0]).toEqual(['refresh_1', 'grant_expired']);
  });

  it('does not return a refreshed provider token when the control-plane session disappears before marking issued', async () => {
    const auth = createAuth();
    const providerTokenService = createProviderTokenService();
    const pool = createPool({ deleteBeforeMarkIssued: true });
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter(), { auth, providerTokenService });

    await request(app)
      .post('/api/docs/doc_1/branches/branch_1/collab/session/session_server/provider-token/refresh')
      .send({ refreshToken: serverSessionRefreshToken })
      .expect(404);

    expect(providerTokenService.issued).toHaveLength(1);
    expect(pool.statusUpdates[0]).toEqual(['issuance_1', 'doc_1', 'branch_1', 'session_server']);
    expect(pool.statusUpdates[1]).toEqual(['issuance_1', 'failed', 'provider_token_issue_failed']);
  });

  it('does not mint a provider token if the audit insert fails', async () => {
    const auth = createAuth();
    const providerTokenService = createProviderTokenService();
    const app = createHttpApp(createPool({ failAuditInsert: true }), createUnavailableLiveMarkdownWriter(), { auth, providerTokenService });

    await request(app)
      .post('/api/docs/doc_1/branches/branch_1/collab/session')
      .send({ mode: 'edit', clientKind: 'browser', displayName: 'Alice' })
      .expect(500);

    expect(providerTokenService.issued).toEqual([]);
  });

  it('marks provider token issuances failed when Y-Sweet token minting fails after audit insert', async () => {
    const auth = createAuth();
    const providerTokenService = createProviderTokenService({ failIssue: true });
    const pool = createPool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter(), { auth, providerTokenService });

    await request(app)
      .post('/api/docs/doc_1/branches/branch_1/collab/session')
      .send({ mode: 'edit', clientKind: 'browser', displayName: 'Alice' })
      .expect(500);

    expect(providerTokenService.issued).toHaveLength(1);
    expect(pool.statusUpdates[0]).toEqual(['issuance_1', 'failed', 'provider_token_issue_failed']);
  });

  it('does not persist secret-bearing provider error messages in audit rows', async () => {
    const auth = createAuth();
    const providerTokenService = createProviderTokenService({
      failIssue: true,
      failMessage: 'failed https://ysweet.example.test?token=secret',
    });
    const pool = createPool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter(), { auth, providerTokenService });

    await request(app)
      .post('/api/docs/doc_1/branches/branch_1/collab/session')
      .send({ mode: 'edit', clientKind: 'browser', displayName: 'Alice' })
      .expect(500);

    expect(pool.statusUpdates[0]).toEqual(['issuance_1', 'failed', 'provider_token_issue_failed']);
  });

  it('does not persist secret-bearing provider error messages in refresh-denial audit rows', async () => {
    const auth = createAuth();
    const providerTokenService = createProviderTokenService({
      failIssue: true,
      failMessage: 'failed https://ysweet.example.test?token=secret',
    });
    const pool = createPool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter(), { auth, providerTokenService });

    await request(app)
      .post('/api/docs/doc_1/branches/branch_1/collab/session/session_server/provider-token/refresh')
      .send({ refreshToken: serverSessionRefreshToken })
      .expect(500);

    expect(pool.statusUpdates[0]).toEqual(['issuance_1', 'failed', 'provider_token_issue_failed']);
    expect(pool.refreshDenied[0]).toEqual(['refresh_1', 'provider_token_refresh_denied']);
  });

  it('does not issue a refresh provider token when write access is denied', async () => {
    const auth = createAuth({ denyWrite: true });
    const providerTokenService = createProviderTokenService();
    const pool = createPool({
      activeSessionActorGrantId: null,
      activeSessionActorId: 'user_1',
      activeSessionClientKind: 'browser',
      activeSessionIsGuest: false,
    });
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter(), { auth, providerTokenService });

    await request(app)
      .post('/api/docs/doc_1/branches/branch_1/collab/session/session_server/provider-token/refresh')
      .send({ refreshToken: serverSessionRefreshToken })
      .expect(403);

    expect(auth.operations).toEqual(['write']);
    expect(providerTokenService.issued).toEqual([]);
    expect(pool.refreshAttempts[0]).toEqual(['session_server']);
    expect(pool.refreshDenied[0]).toEqual(['refresh_1', 'forbidden']);
  });

  it('does not refresh an edit session minted for a different grant', async () => {
    const auth = createAuth({ grantId: 'grant_2' });
    const providerTokenService = createProviderTokenService();
    const app = createHttpApp(
      createPool({ activeSessionActorGrantId: 'grant_1', activeSessionActorId: 'access:token_hash', activeSessionIsGuest: false }),
      createUnavailableLiveMarkdownWriter(),
      { auth, providerTokenService },
    );

    await request(app)
      .post('/api/docs/doc_1/branches/branch_1/collab/session/session_server/provider-token/refresh')
      .send({ refreshToken: serverSessionRefreshToken })
      .expect(403);

    expect(providerTokenService.issued).toEqual([]);
  });

  it('does not refresh an edit session minted for the same grant but a different actor id', async () => {
    const auth = createAuth({ grantId: 'grant_1', actorId: 'user_2' });
    const providerTokenService = createProviderTokenService();
    const app = createHttpApp(
      createPool({ activeSessionActorGrantId: 'grant_1', activeSessionActorId: 'user_1', activeSessionIsGuest: false }),
      createUnavailableLiveMarkdownWriter(),
      { auth, providerTokenService },
    );

    await request(app)
      .post('/api/docs/doc_1/branches/branch_1/collab/session/session_server/provider-token/refresh')
      .send({ refreshToken: serverSessionRefreshToken })
      .expect(403);

    expect(providerTokenService.issued).toEqual([]);
  });

  it('does not refresh an edit session for a grant without matching actor identity', async () => {
    const auth = createAuth({ grantId: 'grant_1', actorId: null });
    const providerTokenService = createProviderTokenService();
    const app = createHttpApp(
      createPool({ activeSessionActorGrantId: 'grant_1', activeSessionActorId: 'user_1', activeSessionIsGuest: false }),
      createUnavailableLiveMarkdownWriter(),
      { auth, providerTokenService },
    );

    await request(app)
      .post('/api/docs/doc_1/branches/branch_1/collab/session/session_server/provider-token/refresh')
      .send({ refreshToken: serverSessionRefreshToken })
      .expect(403);

    expect(providerTokenService.issued).toEqual([]);
  });

  it('does not refresh a grantless edit session minted for a different actor id', async () => {
    const auth = createAuth({ grantId: null, actorId: 'user_2' });
    const providerTokenService = createProviderTokenService();
    const app = createHttpApp(
      createPool({ activeSessionActorGrantId: null, activeSessionActorId: 'user_1' }),
      createUnavailableLiveMarkdownWriter(),
      { auth, providerTokenService },
    );

    await request(app)
      .post('/api/docs/doc_1/branches/branch_1/collab/session/session_server/provider-token/refresh')
      .send({ refreshToken: serverSessionRefreshToken })
      .expect(403);

    expect(providerTokenService.issued).toEqual([]);
  });

  it('does not refresh a grantless edit session minted for a different actor type', async () => {
    const auth = createAuth({ grantId: null, actorId: 'agent:shared_actor', actorType: 'agent' });
    const providerTokenService = createProviderTokenService();
    const app = createHttpApp(
      createPool({
        activeSessionActorGrantId: null,
        activeSessionActorId: 'agent:shared_actor',
        activeSessionActorType: 'user',
      }),
      createUnavailableLiveMarkdownWriter(),
      { auth, providerTokenService },
    );

    await request(app)
      .post('/api/docs/doc_1/branches/branch_1/collab/session/session_server/provider-token/refresh')
      .send({ refreshToken: serverSessionRefreshToken })
      .expect(403);

    expect(providerTokenService.issued).toEqual([]);
  });

  it('does not refresh a session after the latest issuance status is revoked', async () => {
    const auth = createAuth();
    const providerTokenService = createProviderTokenService();
    const pool = createPool({ activeSessionStatus: 'revoked' });
    const app = createHttpApp(
      pool,
      createUnavailableLiveMarkdownWriter(),
      { auth, providerTokenService },
    );

    await request(app)
      .post('/api/docs/doc_1/branches/branch_1/collab/session/session_server/provider-token/refresh')
      .send({ refreshToken: serverSessionRefreshToken })
      .expect(403, { error: 'provider_token_revoked' });

    expect(providerTokenService.issued).toEqual([]);
    expect(pool.refreshAttempts[0]).toEqual(['session_server']);
    expect(pool.refreshDenied[0]).toEqual(['refresh_1', 'provider_token_revoked']);
  });

  it('does not refresh a provider token after the control-plane session row is gone', async () => {
    const auth = createAuth();
    const providerTokenService = createProviderTokenService();
    const app = createHttpApp(
      createPool({ missingCollabSession: true }),
      createUnavailableLiveMarkdownWriter(),
      { auth, providerTokenService },
    );

    await request(app)
      .post('/api/docs/doc_1/branches/branch_1/collab/session/session_server/provider-token/refresh')
      .send({ refreshToken: serverSessionRefreshToken })
      .expect(404);

    expect(providerTokenService.issued).toEqual([]);
  });

  it('does not refresh unknown or client-invented edit sessions', async () => {
    const auth = createAuth();
    const providerTokenService = createProviderTokenService();
    const app = createHttpApp(createPool(), createUnavailableLiveMarkdownWriter(), { auth, providerTokenService });

    await request(app)
      .post('/api/docs/doc_1/branches/branch_1/collab/session/spoofed_session/provider-token/refresh')
      .send({ refreshToken: serverSessionRefreshToken })
      .expect(404);

    expect(providerTokenService.issued).toEqual([]);
  });
});
