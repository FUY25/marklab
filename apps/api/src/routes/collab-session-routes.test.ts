import { createHash } from 'node:crypto';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DbPool, DbQueryResult, DbTransactionClient } from '../db/client';
import { createHttpApp, type HttpRequestAuth } from '../http/app';
import { PROVIDER_TOKEN_TTL_SECONDS } from '../config/provider-token-policy';
import type { ProviderTokenService } from '../provider/ysweet-token-service';
import { createUnavailableLiveMarkdownWriter } from '../services/live-writer';

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
  revokeDuringRefresh?: boolean;
  missingCollabSession?: boolean;
  missingBranchState?: boolean;
  initialProviderDocId?: string | null;
  initialProviderDocSeededAt?: string | null;
  failSeedMarkOnce?: boolean;
} = {}): DbPool & {
  collabSessions: readonly (readonly unknown[])[];
  collabSessionTouches: readonly (readonly unknown[])[];
  collabSessionDeletes: readonly (readonly unknown[])[];
  providerDocSeedMarks: readonly (readonly unknown[])[];
  issuances: readonly (readonly unknown[])[];
  statusUpdates: readonly (readonly unknown[])[];
} {
  const serverSessionId = 'session_server';
  let providerDocId = Object.hasOwn(input, 'initialProviderDocId') ? input.initialProviderDocId ?? null : 'ml_doc_existing';
  let providerDocSeededAt = providerDocId
    ? Object.hasOwn(input, 'initialProviderDocSeededAt') ? input.initialProviderDocSeededAt ?? null : '2026-05-11T00:00:00.000Z'
    : null;
  let seedMarkFailuresRemaining = input.failSeedMarkOnce ? 1 : 0;
  const collabSessions: (readonly unknown[])[] = [];
  const collabSessionTouches: (readonly unknown[])[] = [];
  const collabSessionDeletes: (readonly unknown[])[] = [];
  const providerDocSeedMarks: (readonly unknown[])[] = [];
  const issuances: (readonly unknown[])[] = [];
  const statusUpdates: (readonly unknown[])[] = [];
  const query: DbPool['query'] = async <Row = unknown>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<DbQueryResult<Row>> => {
    if (/insert into collab_sessions/u.test(sql)) {
      collabSessions.push(params ?? []);
      return { rows: [{ id: params?.[0] } as Row], rowCount: 1 };
    }
    if (/update collab_sessions/u.test(sql)) {
      collabSessionTouches.push(params ?? []);
      return { rows: [], rowCount: input.missingCollabSession ? 0 : 1 };
    }
    if (/delete from collab_sessions/u.test(sql)) {
      collabSessionDeletes.push(params ?? []);
      return { rows: [], rowCount: 1 };
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
    if (/^(begin|commit|rollback)$/iu.test(sql.trim())) return { rows: [], rowCount: 0 };
    if (/pg_advisory_xact_lock/u.test(sql)) return { rows: [{} as Row], rowCount: 1 };
    if (/select 1\s+from provider_token_issuances pending/u.test(sql)) {
      return { rows: input.revokeDuringRefresh ? [] : [{ active: 1 } as Row], rowCount: input.revokeDuringRefresh ? 0 : 1 };
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
    collabSessionTouches,
    collabSessionDeletes,
    providerDocSeedMarks,
    issuances,
    statusUpdates,
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
        ...(grantId ? { grantId, role: operation === 'write' ? 'edit' : 'view' } : {}),
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

  it('normalizes user-supplied app and daemon client kinds to browser sessions', async () => {
    const auth = createAuth({ grantId: 'grant_1', actorId: 'access:token_hash' });
    const providerTokenService = createProviderTokenService();
    const pool = createPool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter(), { auth, providerTokenService });

    const response = await request(app)
      .post('/api/docs/doc_1/branches/branch_1/collab/session')
      .send({ mode: 'edit', clientKind: 'daemon', displayName: 'Alice' })
      .expect(201);

    expect(response.body.session.clientKind).toBe('browser');
    expect(pool.issuances[0]).toEqual(expect.arrayContaining(['browser', 'user']));
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
    expect(pool.collabSessionDeletes).toHaveLength(1);
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

  it('does not charge identity-bearing access-grant edit sessions against guest quota', async () => {
    const auth = createAuth({ grantId: 'grant_1', actorId: 'access:token_hash' });
    const providerTokenService = createProviderTokenService();
    const pool = createPool({ activeGuestSessions: 3 });
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter(), { auth, providerTokenService });

    const response = await request(app)
      .post('/api/docs/doc_1/branches/branch_1/collab/session')
      .send({ mode: 'edit', clientKind: 'browser', displayName: 'Member' })
      .expect(201);

    expect(response.body.session.sessionId).toMatch(/^session_[0-9a-f-]{36}$/u);
    expect(pool.collabSessions[0]?.[6]).toBe('access:token_hash');
    expect(pool.collabSessions[0]?.[9]).toBe(false);
    expect(pool.issuances[0]).toEqual(expect.arrayContaining(['browser', 'user', 'access:token_hash', 'grant_1']));
    expect(providerTokenService.issued).toHaveLength(1);
  });

  it('does not return an initial edit provider token when the grant is revoked while the provider token is minting', async () => {
    const auth = createAuth();
    const providerTokenService = createProviderTokenService();
    const pool = createPool({ revokeDuringRefresh: true });
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter(), { auth, providerTokenService });

    await request(app)
      .post('/api/docs/doc_1/branches/branch_1/collab/session')
      .send({ mode: 'edit', clientKind: 'browser', displayName: 'Guest' })
      .expect(404);

    expect(providerTokenService.issued).toHaveLength(0);
    expect(pool.statusUpdates[0]).toEqual(['issuance_1', 'failed', 'provider_token_issue_failed']);
    expect(pool.collabSessionDeletes).toHaveLength(1);
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
    expect(response.body.providerToken).toBeUndefined();
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

  it('refreshes an edit provider token only after write access succeeds', async () => {
    const auth = createAuth();
    const providerTokenService = createProviderTokenService();
    const pool = createPool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter(), { auth, providerTokenService });

    const response = await request(app)
      .post('/api/docs/doc_1/branches/branch_1/collab/session/session_server/provider-token/refresh')
      .send({ refreshToken: serverSessionRefreshToken, clientKind: 'guest' })
      .expect(200);

    expect(auth.operations).toEqual(['write']);
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
  });

  it('refreshes identity-bearing access-grant edit sessions with stable actor identity', async () => {
    const auth = createAuth({ grantId: 'grant_1', actorId: 'access:token_hash' });
    const providerTokenService = createProviderTokenService();
    const pool = createPool({
      activeSessionActorGrantId: 'grant_1',
      activeSessionActorId: 'access:token_hash',
      activeSessionClientKind: 'browser',
      activeSessionIsGuest: false,
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
        actorId: 'grant:grant_1',
        displayName: 'Guest',
        isGuest: false,
      }),
    })]);
    expect(pool.issuances[0]).toEqual(expect.arrayContaining([
      'browser',
      'user',
      'access:token_hash',
      'grant_1',
    ]));
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
    const app = createHttpApp(createPool(), createUnavailableLiveMarkdownWriter(), { auth, providerTokenService });

    await request(app)
      .post('/api/docs/doc_1/branches/branch_1/collab/session/session_server/provider-token/refresh')
      .send({ refreshToken: 'wrong_refresh_token_012345678901234567890' })
      .expect(404);

    expect(providerTokenService.issued).toEqual([]);
  });

  it('does not mark a refresh issued when the session is revoked while the provider token is minting', async () => {
    const auth = createAuth();
    const providerTokenService = createProviderTokenService();
    const pool = createPool({ revokeDuringRefresh: true });
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter(), { auth, providerTokenService });

    await request(app)
      .post('/api/docs/doc_1/branches/branch_1/collab/session/session_server/provider-token/refresh')
      .send({ refreshToken: serverSessionRefreshToken })
      .expect(404);

    expect(providerTokenService.issued).toHaveLength(0);
    expect(pool.statusUpdates[0]).toEqual(['issuance_1', 'failed', 'provider_token_issue_failed']);
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

  it('does not issue a refresh provider token when write access is denied', async () => {
    const auth = createAuth({ denyWrite: true });
    const providerTokenService = createProviderTokenService();
    const app = createHttpApp(createPool(), createUnavailableLiveMarkdownWriter(), { auth, providerTokenService });

    await request(app)
      .post('/api/docs/doc_1/branches/branch_1/collab/session/session_server/provider-token/refresh')
      .send({ refreshToken: serverSessionRefreshToken })
      .expect(403);

    expect(auth.operations).toEqual(['write']);
    expect(providerTokenService.issued).toEqual([]);
  });

  it('does not refresh an edit session minted for a different grant', async () => {
    const auth = createAuth({ grantId: 'grant_2' });
    const providerTokenService = createProviderTokenService();
    const app = createHttpApp(createPool({ activeSessionActorGrantId: 'grant_1' }), createUnavailableLiveMarkdownWriter(), {
      auth,
      providerTokenService,
    });

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
      createPool({ activeSessionActorGrantId: 'grant_1', activeSessionActorId: 'user_1' }),
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
      createPool({ activeSessionActorGrantId: 'grant_1', activeSessionActorId: 'user_1' }),
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
    const app = createHttpApp(
      createPool({ activeSessionStatus: 'revoked' }),
      createUnavailableLiveMarkdownWriter(),
      { auth, providerTokenService },
    );

    await request(app)
      .post('/api/docs/doc_1/branches/branch_1/collab/session/session_server/provider-token/refresh')
      .send({ refreshToken: serverSessionRefreshToken })
      .expect(404);

    expect(providerTokenService.issued).toEqual([]);
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
