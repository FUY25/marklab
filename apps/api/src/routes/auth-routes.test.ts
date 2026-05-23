import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { DbPool, DbQueryResult, DbTransactionClient } from '../db/client';
import { createHttpApp } from '../http/app';
import { hashToken } from '../services/access-control';
import { createUnavailableLiveMarkdownWriter } from '../services/live-writer';

const originalDevAuth = process.env.MARKLAB_ENABLE_DEV_AUTH;
const originalRequireAuth = process.env.MARKLAB_REQUIRE_AUTH;
const originalDevAnonymousCollab = process.env.MARKLAB_ENABLE_DEV_ANONYMOUS_COLLAB;
const originalNodeEnv = process.env.NODE_ENV;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

afterEach(() => {
  restoreEnv('MARKLAB_ENABLE_DEV_AUTH', originalDevAuth);
  restoreEnv('MARKLAB_REQUIRE_AUTH', originalRequireAuth);
  restoreEnv('MARKLAB_ENABLE_DEV_ANONYMOUS_COLLAB', originalDevAnonymousCollab);
  restoreEnv('NODE_ENV', originalNodeEnv);
});

interface UserRecord {
  id: string;
  email: string;
  display_name: string;
  auth_provider: string;
  auth_subject: string;
}

interface SessionRecord {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: Date | string;
  revoked_at: Date | string | null;
}

interface OidcStateRecord {
  state_hash: string;
  code_verifier: string;
  native_callback: boolean;
  native_app_state: string | null;
  return_to: string | null;
  expires_at: Date | string;
  used_at: Date | string | null;
}

function createAuthPool(input: { expired?: boolean } = {}) {
  const users: UserRecord[] = [];
  const sessions: SessionRecord[] = [];
  const oidcStates: OidcStateRecord[] = [];
  let nextUserId = 1;
  let nextSessionId = 1;

  const query: DbPool['query'] = async <Row = unknown>(sql: string, params?: readonly unknown[]): Promise<DbQueryResult<Row>> => {
    if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return { rows: [], rowCount: 0 };

    if (sql.includes('insert into users')) {
      const provider = String(params?.[2]);
      const subject = String(params?.[3]);
      let user = users.find((candidate) => candidate.auth_provider === provider && candidate.auth_subject === subject);
      if (!user) {
        if (users.some((candidate) => candidate.email === params?.[0])) {
          const error = new Error('duplicate email') as Error & { code: string; constraint: string };
          error.code = '23505';
          error.constraint = 'users_email_key';
          throw error;
        }
        user = {
          id: `user_${nextUserId++}`,
          email: String(params?.[0]),
          display_name: String(params?.[1]),
          auth_provider: provider,
          auth_subject: subject,
        };
        users.push(user);
      } else {
        user.email = String(params?.[0]);
        user.display_name = String(params?.[1]);
        user.auth_provider = provider;
        user.auth_subject = subject;
      }
      return { rows: [user as Row], rowCount: 1 };
    }

    if (sql.includes('update users') && sql.includes("auth_provider = 'manual-alpha'")) {
      const user = users.find((candidate) => candidate.email === params?.[0] && candidate.auth_provider === 'manual-alpha');
      if (!user) return { rows: [], rowCount: 0 };
      if (users.some((candidate) => candidate !== user && candidate.auth_provider === params?.[2] && candidate.auth_subject === params?.[3])) {
        const error = new Error('duplicate subject') as Error & { code: string; constraint: string };
        error.code = '23505';
        error.constraint = 'users_auth_provider_auth_subject_key';
        throw error;
      }
      user.display_name = String(params?.[1]);
      user.auth_provider = String(params?.[2]);
      user.auth_subject = String(params?.[3]);
      return { rows: [user as Row], rowCount: 1 };
    }

    if (sql.includes('insert into user_sessions')) {
      const row: SessionRecord = {
        id: `usr_session_${nextSessionId++}`,
        user_id: String(params?.[0]),
        token_hash: String(params?.[1]),
        expires_at: input.expired ? '2026-01-01T00:00:00.000Z' : '2999-01-01T00:00:00.000Z',
        revoked_at: null,
      };
      sessions.push(row);
      return { rows: [row as Row], rowCount: 1 };
    }

    if (sql.includes('insert into oidc_login_states')) {
      oidcStates.push({
        state_hash: String(params?.[0]),
        code_verifier: String(params?.[1]),
        native_callback: params?.[2] === true,
        native_app_state: typeof params?.[3] === 'string' ? params[3] : null,
        return_to: typeof params?.[4] === 'string' ? params[4] : null,
        expires_at: '2999-01-01T00:00:00.000Z',
        used_at: null,
      });
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes('update oidc_login_states')) {
      const state = oidcStates.find((candidate) => candidate.state_hash === params?.[0] && !candidate.used_at);
      if (!state) return { rows: [], rowCount: 0 };
      state.used_at = '2026-05-11T00:00:00.000Z';
      return { rows: [{
        code_verifier: state.code_verifier,
        native_callback: state.native_callback,
        native_app_state: state.native_app_state,
        return_to: state.return_to,
      } as Row], rowCount: 1 };
    }

    if (sql.includes('update user_sessions') && sql.includes('from users')) {
      const session = sessions.find((candidate) => candidate.token_hash === params?.[0] && !candidate.revoked_at && !input.expired);
      const user = session ? users.find((candidate) => candidate.id === session.user_id) : undefined;
      if (!session || !user) return { rows: [], rowCount: 0 };
      return { rows: [{ session_id: session.id, id: user.id, email: user.email, display_name: user.display_name } as Row], rowCount: 1 };
    }

    if (sql.includes('update user_sessions') && sql.includes('set revoked_at = now()')) {
      const session = sessions.find((candidate) => candidate.token_hash === params?.[0] && !candidate.revoked_at);
      if (session) session.revoked_at = '2026-05-11T00:00:00.000Z';
      return { rows: [], rowCount: session ? 1 : 0 };
    }

    throw new Error(`unexpected_query:${sql}`);
  };

  const pool: DbPool = {
    query,
    async connect(): Promise<DbTransactionClient> {
      return {
        query,
        release: () => undefined,
      };
    },
  };

  return { pool, users, sessions, oidcStates };
}

function setCookies(response: request.Response): string[] {
  const cookies = response.headers['set-cookie'];
  if (!Array.isArray(cookies)) throw new Error('missing_set_cookie');
  return cookies;
}

describe('auth routes', () => {
  it('creates a dev alpha session, stores only the token hash, and reads it back through bearer auth', async () => {
    process.env.MARKLAB_ENABLE_DEV_AUTH = 'true';
    const { pool, sessions } = createAuthPool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter());

    const login = await request(app)
      .post('/api/auth/dev-login')
      .send({ email: 'ALICE@example.com', givenName: 'Alice', familyName: 'Ng' })
      .expect(201);

    expect(login.body).toMatchObject({
      user: {
        userId: 'user_1',
        email: 'alice@example.com',
        displayName: 'Alice Ng',
      },
      sessionId: 'usr_session_1',
      token: expect.stringMatching(/^ml_user_/u),
      expiresAt: '2999-01-01T00:00:00.000Z',
    });
    expect(sessions[0]?.token_hash).toBe(hashToken(login.body.token));
    expect(sessions[0]?.token_hash).not.toBe(login.body.token);
    const sessionCookie = setCookies(login).find((cookie) => cookie.startsWith('marklab_session='));
    expect(sessionCookie).toContain('Path=/api');
    expect(sessionCookie).not.toContain('Path=/;');

    await request(app)
      .get('/api/auth/session')
      .set({ Authorization: `Bearer ${login.body.token}` })
      .expect(200, {
        authenticated: true,
        user: {
          userId: 'user_1',
          email: 'alice@example.com',
          displayName: 'Alice Ng',
        },
      });
  });

  it('creates an OIDC-backed session while dev alpha login is disabled', async () => {
    process.env.MARKLAB_ENABLE_DEV_AUTH = 'false';
    const { pool, sessions, oidcStates } = createAuthPool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter(), {
      authEnvironment: {
        devAuth: false,
        oidc: {
          issuer: 'https://login.example.test',
          clientId: 'marklab-client',
          clientSecret: 'marklab-secret',
          redirectUri: 'https://marklab.example.test/auth/callback',
          authorizationEndpoint: 'https://login.example.test/authorize',
        },
      },
      oidcExchange: async (input) => {
        expect(input).toMatchObject({
          code: 'oidc_code_1',
          codeVerifier: expect.stringMatching(/^[A-Za-z0-9_-]{43,}$/u),
          config: expect.objectContaining({
            issuer: 'https://login.example.test',
            clientId: 'marklab-client',
            clientSecret: 'marklab-secret',
            redirectUri: 'https://marklab.example.test/auth/callback',
            authorizationEndpoint: 'https://login.example.test/authorize',
          }),
        });
        return {
          provider: 'https://login.example.test',
          subject: 'subject_1',
          email: 'ALICE@example.com',
          name: 'Alice OIDC',
        };
      },
    });

    const started = await request(app)
      .post('/api/auth/oidc/start')
      .send({ native: true, appState: 'native_state_native_state_native_state_1', returnTo: '/workspaces/ws_1/settings' })
      .expect(201);
    const state = new URL(started.body.authorizationUrl).searchParams.get('state');
    const codeChallenge = new URL(started.body.authorizationUrl).searchParams.get('code_challenge');
    expect(state).toMatch(/^[A-Za-z0-9_-]{43,}$/u);
    expect(codeChallenge).toMatch(/^[A-Za-z0-9_-]{43,}$/u);
    expect(oidcStates).toHaveLength(1);
    expect(oidcStates[0]?.native_callback).toBe(true);
    expect(oidcStates[0]?.native_app_state).toBe('native_state_native_state_native_state_1');
    expect(oidcStates[0]?.return_to).toBe('/workspaces/ws_1/settings');
    const cookies = setCookies(started);

    const login = await request(app)
      .post('/api/auth/oidc/callback')
      .set('Cookie', cookies)
      .send({ code: 'oidc_code_1', state })
      .expect(201);

    expect(login.body).toMatchObject({
      user: {
        userId: 'user_1',
        email: 'alice@example.com',
        displayName: 'Alice OIDC',
      },
      sessionId: 'usr_session_1',
      token: expect.stringMatching(/^ml_user_/u),
      nativeCallback: true,
      nativeAppState: 'native_state_native_state_native_state_1',
      returnTo: '/workspaces/ws_1/settings',
    });
    expect(sessions[0]?.token_hash).toBe(hashToken(login.body.token));

    await request(app)
      .post('/api/auth/dev-login')
      .send({ email: 'attacker@example.com', name: 'Attacker' })
      .expect(403, { error: 'dev_auth_disabled' });
  });

  it('requires a native app state when starting a native OIDC sign-in', async () => {
    const { pool } = createAuthPool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter(), {
      authEnvironment: {
        oidc: {
          issuer: 'https://login.example.test',
          clientId: 'marklab-client',
          clientSecret: 'marklab-secret',
          redirectUri: 'https://marklab.example.test/auth/callback',
          authorizationEndpoint: 'https://login.example.test/authorize',
        },
      },
    });

    await request(app)
      .post('/api/auth/oidc/start')
      .send({ native: true })
      .expect(400, { error: 'native_auth_state_required' });
  });

  it('rebinds a manual-alpha bootstrap owner to verified OIDC without losing the user id', async () => {
    process.env.MARKLAB_ENABLE_DEV_AUTH = 'false';
    const { pool, users } = createAuthPool();
    users.push({
      id: 'user_manual',
      email: 'alice@example.com',
      display_name: 'Alice Manual',
      auth_provider: 'manual-alpha',
      auth_subject: 'alice@example.com',
    });
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter(), {
      authEnvironment: {
        devAuth: false,
        oidc: {
          issuer: 'https://accounts.google.com',
          clientId: 'marklab-client',
          clientSecret: 'marklab-secret',
          redirectUri: 'https://marklab.example.test/auth/callback',
          authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
        },
      },
      oidcExchange: async () => ({
        provider: 'https://accounts.google.com',
        subject: 'google-subject-1',
        email: 'ALICE@example.com',
        name: 'Alice Google',
      }),
    });

    const started = await request(app)
      .post('/api/auth/oidc/start')
      .expect(201);
    const state = new URL(started.body.authorizationUrl).searchParams.get('state');

    const login = await request(app)
      .post('/api/auth/oidc/callback')
      .set('Cookie', setCookies(started))
      .send({ code: 'oidc_code_1', state })
      .expect(201);

    expect(login.body.user).toMatchObject({
      userId: 'user_manual',
      email: 'alice@example.com',
      displayName: 'Alice Google',
    });
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({
      id: 'user_manual',
      auth_provider: 'https://accounts.google.com',
      auth_subject: 'google-subject-1',
      display_name: 'Alice Google',
    });
  });

  it('rejects missing and replayed OIDC login state before exchanging the code', async () => {
    const { pool } = createAuthPool();
    let exchangeCount = 0;
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter(), {
      authEnvironment: {
        oidc: {
          issuer: 'https://login.example.test',
          clientId: 'marklab-client',
          clientSecret: 'marklab-secret',
          redirectUri: 'https://marklab.example.test/auth/callback',
          authorizationEndpoint: 'https://login.example.test/authorize',
        },
      },
      oidcExchange: async () => {
        exchangeCount += 1;
        return {
          provider: 'https://login.example.test',
          subject: 'subject_1',
          email: 'alice@example.com',
          name: 'Alice',
        };
      },
    });

    await request(app)
      .post('/api/auth/oidc/callback')
      .send({ code: 'oidc_code_missing', state: 'state_missing_state_missing_state_missing' })
      .expect(401, { error: 'oidc_login_failed' });
    expect(exchangeCount).toBe(0);

    const started = await request(app)
      .post('/api/auth/oidc/start')
      .expect(201);
    const state = new URL(started.body.authorizationUrl).searchParams.get('state');
    const cookies = setCookies(started);

    await request(app)
      .post('/api/auth/oidc/callback')
      .set('Cookie', cookies)
      .send({ code: 'oidc_code_1', state })
      .expect(201);

    await request(app)
      .post('/api/auth/oidc/callback')
      .set('Cookie', cookies)
      .send({ code: 'oidc_code_replay', state })
      .expect(401, { error: 'oidc_login_failed' });
    expect(exchangeCount).toBe(1);
  });

  it('rejects expired sessions', async () => {
    process.env.MARKLAB_ENABLE_DEV_AUTH = 'true';
    const { pool } = createAuthPool({ expired: true });
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter());

    const login = await request(app)
      .post('/api/auth/dev-login')
      .send({ email: 'alice@example.com', name: 'Alice' })
      .expect(201);

    await request(app)
      .get('/api/auth/session')
      .set({ Authorization: `Bearer ${login.body.token}` })
      .expect(401, { authenticated: false });
  });

  it('falls back to a bearer user session when a stale session cookie is present', async () => {
    process.env.MARKLAB_ENABLE_DEV_AUTH = 'true';
    const { pool } = createAuthPool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter());

    const login = await request(app)
      .post('/api/auth/dev-login')
      .send({ email: 'alice@example.com', name: 'Alice' })
      .expect(201);

    await request(app)
      .get('/api/auth/session')
      .set({
        Authorization: `Bearer ${login.body.token}`,
        Cookie: 'marklab_session=stale-token',
      })
      .expect(200, {
        authenticated: true,
        user: {
          userId: 'user_1',
          email: 'alice@example.com',
          displayName: 'Alice',
        },
      });
  });

  it('does not fall back to a cookie when an explicit user bearer token is stale', async () => {
    process.env.MARKLAB_ENABLE_DEV_AUTH = 'true';
    const { pool } = createAuthPool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter());

    const login = await request(app)
      .post('/api/auth/dev-login')
      .send({ email: 'alice@example.com', name: 'Alice' })
      .expect(201);

    await request(app)
      .get('/api/auth/session')
      .set({
        Authorization: 'Bearer ml_user_stale_token',
        Cookie: `marklab_session=${login.body.token}`,
      })
      .expect(401, { authenticated: false });
  });

  it('rejects a same-email login with a different subject instead of rebinding identity', async () => {
    process.env.MARKLAB_ENABLE_DEV_AUTH = 'true';
    const { pool, users } = createAuthPool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter());

    await request(app)
      .post('/api/auth/dev-login')
      .send({ email: 'alice@example.com', name: 'Alice', subject: 'subject-one' })
      .expect(201);

    await request(app)
      .post('/api/auth/dev-login')
      .send({ email: 'alice@example.com', name: 'Alice Updated', subject: 'subject-two' })
      .expect(409, { error: 'email_already_linked' });

    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ auth_subject: 'subject-one', display_name: 'Alice' });
  });

  it('uses the normalized email as the default dev subject', async () => {
    process.env.MARKLAB_ENABLE_DEV_AUTH = 'true';
    const { pool, users } = createAuthPool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter());

    await request(app)
      .post('/api/auth/dev-login')
      .send({ email: 'ALICE@example.com', name: 'Alice' })
      .expect(201);

    await request(app)
      .post('/api/auth/dev-login')
      .send({ email: 'alice@example.com', name: 'Alice Updated' })
      .expect(201);

    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({
      email: 'alice@example.com',
      auth_provider: 'dev',
      auth_subject: 'alice@example.com',
      display_name: 'Alice Updated',
    });
  });

  it('keeps dev login disabled unless explicitly enabled', async () => {
    process.env.MARKLAB_ENABLE_DEV_AUTH = 'false';
    const { pool } = createAuthPool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter());

    await request(app)
      .post('/api/auth/dev-login')
      .send({ email: 'alice@example.com', name: 'Alice' })
      .expect(403, { error: 'dev_auth_disabled' });
  });

  it('keeps dev login disabled in production even when the env flag is set', async () => {
    process.env.NODE_ENV = 'production';
    process.env.MARKLAB_ENABLE_DEV_AUTH = 'true';
    const { pool } = createAuthPool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter());

    await request(app)
      .post('/api/auth/dev-login')
      .send({ email: 'alice@example.com', name: 'Alice' })
      .expect(403, { error: 'dev_auth_disabled' });
  });
});
