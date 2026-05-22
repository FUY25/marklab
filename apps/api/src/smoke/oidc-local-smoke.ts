import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';
import type { DbPool, DbQueryResult, DbTransactionClient } from '../db/client';
import { createHttpApp } from '../http/app';
import { hashToken } from '../services/access-control';
import { createUnavailableLiveMarkdownWriter } from '../services/live-writer';

type WorkspaceRole = 'Owner' | 'Member' | 'Reader';

interface LocalUserRecord {
  id: string;
  email: string;
  display_name: string;
  auth_provider: string;
  auth_subject: string;
}

interface LocalSessionRecord {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: string;
  revoked_at: string | null;
}

interface LocalOidcStateRecord {
  state_hash: string;
  code_verifier: string;
  expires_at: string;
  used_at: string | null;
}

interface LocalWorkspaceRecord {
  id: string;
  name: string;
  owner_user_id: string;
}

interface LocalWorkspaceMemberRecord {
  workspace_id: string;
  user_id: string;
  role: WorkspaceRole;
}

interface MockOidcState {
  authorizationRequests: number;
  discoveryRequests: number;
  tokenRequests: number;
  userinfoRequests: number;
}

interface IssuedCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  used: boolean;
}

interface MockAccessTokenClaims {
  sub: string;
  email: string;
  email_verified: true;
  name: string;
}

export interface OidcLocalSmokeResult {
  ok: true;
  checks: string[];
  apiBaseUrl: string;
  oidcIssuer: string;
  user: {
    userId: string;
    email: string;
    displayName: string;
  };
  workspace: {
    workspaceId: string;
    name: string;
    role: WorkspaceRole;
  };
  nativeCallbackUrl: string;
  oidcRequests: MockOidcState;
}

const mockClientId = 'marklab-local-smoke';
const mockClientSecret = 'marklab-local-smoke-secret';
const mockUser = {
  sub: 'local-smoke-owner',
  email: 'owner@example.test',
  email_verified: true,
  name: 'Owner Smoke',
} satisfies MockAccessTokenClaims;

function base64UrlSha256(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { location });
  res.end();
}

function badRequest(res: ServerResponse, error: string): void {
  json(res, 400, { error });
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function listen(server: Server, port = 0): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server_listen_failed');
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await listen(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('port_reservation_failed');
  const port = (address as AddressInfo).port;
  await close(server);
  return port;
}

function createLocalGate6Pool(): { pool: DbPool; state: { users: LocalUserRecord[]; workspaces: LocalWorkspaceRecord[] } } {
  const users: LocalUserRecord[] = [];
  const sessions: LocalSessionRecord[] = [];
  const oidcStates: LocalOidcStateRecord[] = [];
  const workspaces: LocalWorkspaceRecord[] = [];
  const members: LocalWorkspaceMemberRecord[] = [];
  let nextUserId = 1;
  let nextSessionId = 1;
  let nextWorkspaceId = 1;

  const query: DbPool['query'] = async <Row = unknown>(sql: string, params?: readonly unknown[]): Promise<DbQueryResult<Row>> => {
    if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return { rows: [], rowCount: 0 };

    if (sql.includes('insert into oidc_login_states')) {
      oidcStates.push({
        state_hash: String(params?.[0]),
        code_verifier: String(params?.[1]),
        expires_at: '2999-01-01T00:00:00.000Z',
        used_at: null,
      });
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes('update oidc_login_states')) {
      const state = oidcStates.find((candidate) => candidate.state_hash === params?.[0] && !candidate.used_at);
      if (!state) return { rows: [], rowCount: 0 };
      state.used_at = '2026-05-22T00:00:00.000Z';
      return { rows: [{ code_verifier: state.code_verifier } as Row], rowCount: 1 };
    }

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
      }
      return { rows: [{ id: user.id, email: user.email, display_name: user.display_name } as Row], rowCount: 1 };
    }

    if (sql.includes('insert into user_sessions')) {
      const row: LocalSessionRecord = {
        id: `usr_session_${nextSessionId++}`,
        user_id: String(params?.[0]),
        token_hash: String(params?.[1]),
        expires_at: '2999-01-01T00:00:00.000Z',
        revoked_at: null,
      };
      sessions.push(row);
      return { rows: [{ id: row.id, expires_at: row.expires_at } as Row], rowCount: 1 };
    }

    if (sql.includes('update user_sessions') && sql.includes('from users')) {
      const session = sessions.find((candidate) => candidate.token_hash === params?.[0] && !candidate.revoked_at);
      const user = session ? users.find((candidate) => candidate.id === session.user_id) : undefined;
      if (!session || !user) return { rows: [], rowCount: 0 };
      return {
        rows: [{ session_id: session.id, id: user.id, email: user.email, display_name: user.display_name } as Row],
        rowCount: 1,
      };
    }

    if (sql.includes('insert into workspaces')) {
      const row: LocalWorkspaceRecord = {
        id: `ws_${nextWorkspaceId++}`,
        name: String(params?.[0]),
        owner_user_id: String(params?.[1]),
      };
      workspaces.push(row);
      return { rows: [{ id: row.id, name: row.name, role: 'Owner' } as Row], rowCount: 1 };
    }

    if (sql.includes('insert into workspace_members') && sql.includes("values ($1, $2, 'Owner')")) {
      const existing = members.find((member) => member.workspace_id === params?.[0] && member.user_id === params?.[1]);
      if (existing) {
        existing.role = 'Owner';
      } else {
        members.push({ workspace_id: String(params?.[0]), user_id: String(params?.[1]), role: 'Owner' });
      }
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes('insert into subscriptions')) {
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes('from workspace_members m') && sql.includes('join workspaces w') && sql.includes('where m.user_id = $1')) {
      const rows = members
        .filter((member) => member.user_id === params?.[0])
        .map((member) => {
          const workspace = workspaces.find((candidate) => candidate.id === member.workspace_id);
          if (!workspace) throw new Error(`missing_workspace:${member.workspace_id}`);
          return { id: workspace.id, name: workspace.name, role: member.role };
        })
        .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
      return { rows: rows as Row[], rowCount: rows.length };
    }

    throw new Error(`unexpected_query:${sql}`);
  };

  const pool: DbPool = {
    query,
    async connect(): Promise<DbTransactionClient> {
      return { query, release: () => undefined };
    },
  };

  return { pool, state: { users, workspaces } };
}

async function startMockOidcProvider(): Promise<{ issuer: string; requests: MockOidcState; close: () => Promise<void> }> {
  const requests: MockOidcState = {
    authorizationRequests: 0,
    discoveryRequests: 0,
    tokenRequests: 0,
    userinfoRequests: 0,
  };
  const codes = new Map<string, IssuedCode>();
  const accessTokens = new Map<string, MockAccessTokenClaims>();
  let issuer = '';
  let nextCode = 1;
  let nextAccessToken = 1;

  const server = createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url ?? '/', issuer);
      if (req.method === 'GET' && requestUrl.pathname === '/.well-known/openid-configuration') {
        requests.discoveryRequests += 1;
        json(res, 200, {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          userinfo_endpoint: `${issuer}/userinfo`,
        });
        return;
      }

      if (req.method === 'GET' && requestUrl.pathname === '/authorize') {
        requests.authorizationRequests += 1;
        const redirectUri = requestUrl.searchParams.get('redirect_uri') ?? '';
        const state = requestUrl.searchParams.get('state') ?? '';
        const codeChallenge = requestUrl.searchParams.get('code_challenge') ?? '';
        if (requestUrl.searchParams.get('response_type') !== 'code') return badRequest(res, 'invalid_response_type');
        if (requestUrl.searchParams.get('client_id') !== mockClientId) return badRequest(res, 'invalid_client_id');
        if (!redirectUri || !state || !codeChallenge) return badRequest(res, 'missing_authorize_param');
        if (requestUrl.searchParams.get('code_challenge_method') !== 'S256') return badRequest(res, 'invalid_pkce_method');
        const code = `mock_code_${nextCode++}`;
        codes.set(code, {
          clientId: mockClientId,
          redirectUri,
          codeChallenge,
          used: false,
        });
        const callbackUrl = new URL(redirectUri);
        callbackUrl.searchParams.set('code', code);
        callbackUrl.searchParams.set('state', state);
        redirect(res, callbackUrl.toString());
        return;
      }

      if (req.method === 'POST' && requestUrl.pathname === '/token') {
        requests.tokenRequests += 1;
        const form = new URLSearchParams(await readBody(req));
        const code = form.get('code') ?? '';
        const issued = codes.get(code);
        if (form.get('grant_type') !== 'authorization_code') return badRequest(res, 'invalid_grant_type');
        if (!issued || issued.used) return badRequest(res, 'invalid_code');
        if (form.get('client_id') !== issued.clientId) return badRequest(res, 'invalid_client_id');
        if (form.get('client_secret') !== mockClientSecret) return badRequest(res, 'invalid_client_secret');
        if (form.get('redirect_uri') !== issued.redirectUri) return badRequest(res, 'invalid_redirect_uri');
        const verifier = form.get('code_verifier') ?? '';
        if (base64UrlSha256(verifier) !== issued.codeChallenge) return badRequest(res, 'invalid_pkce_verifier');
        issued.used = true;
        const accessToken = `mock_access_${nextAccessToken++}`;
        accessTokens.set(accessToken, mockUser);
        json(res, 200, { access_token: accessToken, token_type: 'Bearer' });
        return;
      }

      if (req.method === 'GET' && requestUrl.pathname === '/userinfo') {
        requests.userinfoRequests += 1;
        const accessToken = /^Bearer\s+(.+)$/iu.exec(req.headers.authorization ?? '')?.[1] ?? '';
        const claims = accessTokens.get(accessToken);
        if (!claims) return json(res, 401, { error: 'invalid_token' });
        json(res, 200, claims);
        return;
      }

      json(res, 404, { error: 'not_found' });
    } catch (error) {
      json(res, 500, { error: error instanceof Error ? error.message : 'mock_oidc_failed' });
    }
  });

  issuer = await listen(server);
  return {
    issuer,
    requests,
    close: () => close(server),
  };
}

async function fetchJson<T>(input: string, init?: RequestInit): Promise<{ response: Response; body: T }> {
  const response = await fetch(input, {
    ...init,
    headers: {
      accept: 'application/json',
      ...init?.headers,
    },
  });
  const body = await response.json() as T;
  return { response, body };
}

function cookieHeader(response: Response, cookieName: string): string {
  const setCookie = response.headers.get('set-cookie');
  if (!setCookie) throw new Error(`missing_cookie:${cookieName}`);
  const match = new RegExp(`${cookieName}=[^;]+`, 'u').exec(setCookie);
  if (!match) throw new Error(`missing_cookie:${cookieName}`);
  return match[0];
}

function requireOk(response: Response, label: string): void {
  if (!response.ok) throw new Error(`${label}_failed:${response.status}`);
}

function redactedNativeCallbackUrl(input: {
  rawToken: string;
  apiBaseUrl: string;
  webBaseUrl: string;
  userId: string;
  email: string;
  displayName: string;
}): string {
  const callbackUrl = new URL('marklab://auth/callback');
  callbackUrl.searchParams.set('token', 'REDACTED');
  callbackUrl.searchParams.set('apiBaseURL', input.apiBaseUrl);
  callbackUrl.searchParams.set('webBaseURL', input.webBaseUrl);
  callbackUrl.searchParams.set('userId', input.userId);
  callbackUrl.searchParams.set('email', input.email);
  callbackUrl.searchParams.set('displayName', input.displayName);
  if (!input.rawToken.startsWith('ml_user_')) throw new Error('unexpected_user_token_shape');
  return callbackUrl.toString();
}

export async function runLocalOidcSmoke(): Promise<OidcLocalSmokeResult> {
  const checks: string[] = [];
  const oidc = await startMockOidcProvider();
  const apiPort = await reservePort();
  const apiBaseUrl = `http://127.0.0.1:${apiPort}`;
  const webBaseUrl = 'http://127.0.0.1:5173';
  const redirectUri = `${apiBaseUrl}/auth/callback`;
  const { pool } = createLocalGate6Pool();
  const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter(), {
    authEnvironment: {
      devAuth: false,
      nodeEnv: 'test',
      oidc: {
        issuer: oidc.issuer,
        clientId: mockClientId,
        clientSecret: mockClientSecret,
        redirectUri,
      },
    },
  });
  const apiServer = createServer(app);

  try {
    await listen(apiServer, apiPort);

    const start = await fetchJson<{ authorizationUrl: string }>(`${apiBaseUrl}/api/auth/oidc/start`, {
      method: 'POST',
    });
    requireOk(start.response, 'oidc_start');
    const state = new URL(start.body.authorizationUrl).searchParams.get('state');
    if (!state) throw new Error('missing_oidc_state');
    const oidcCookie = cookieHeader(start.response, 'marklab_oidc_state');
    checks.push('oidc_start_sets_state_cookie_and_authorization_url');

    const authorizeResponse = await fetch(start.body.authorizationUrl, { redirect: 'manual' });
    if (authorizeResponse.status !== 302) throw new Error(`authorize_redirect_failed:${authorizeResponse.status}`);
    const callbackLocation = authorizeResponse.headers.get('location');
    if (!callbackLocation) throw new Error('missing_authorize_location');
    const callbackUrl = new URL(callbackLocation);
    const code = callbackUrl.searchParams.get('code');
    const returnedState = callbackUrl.searchParams.get('state');
    if (!code || returnedState !== state) throw new Error('invalid_authorize_callback');
    checks.push('mock_oidc_authorize_redirects_with_code_and_state');

    const callback = await fetchJson<{
      user: { userId: string; email: string; displayName: string };
      token: string;
    }>(`${apiBaseUrl}/api/auth/oidc/callback`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: oidcCookie,
      },
      body: JSON.stringify({ code, state }),
    });
    requireOk(callback.response, 'oidc_callback');
    if (!callback.body.token.startsWith('ml_user_')) throw new Error('missing_user_session_token');
    if (callback.body.user.email !== mockUser.email || callback.body.user.displayName !== mockUser.name) {
      throw new Error('unexpected_user_identity');
    }
    checks.push('oidc_callback_exchanges_code_and_creates_owner_session');

    const bearer = { Authorization: `Bearer ${callback.body.token}` };
    const session = await fetchJson<{ authenticated: boolean; user: { userId: string; email: string; displayName: string } }>(
      `${apiBaseUrl}/api/auth/session`,
      { headers: bearer },
    );
    requireOk(session.response, 'session_read');
    if (!session.body.authenticated || session.body.user.userId !== callback.body.user.userId) throw new Error('session_read_mismatch');
    checks.push('bearer_session_authenticates_api_requests');

    const emptyList = await fetchJson<{ workspaces: unknown[] }>(`${apiBaseUrl}/api/workspaces`, { headers: bearer });
    requireOk(emptyList.response, 'workspace_empty_list');
    if (emptyList.body.workspaces.length !== 0) throw new Error('workspace_list_not_empty');
    checks.push('owner_can_list_empty_workspaces');

    const created = await fetchJson<{ workspace: { workspaceId: string; name: string; role: WorkspaceRole } }>(
      `${apiBaseUrl}/api/workspaces`,
      {
        method: 'POST',
        headers: {
          ...bearer,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'Gate 6 Smoke Workspace' }),
      },
    );
    requireOk(created.response, 'workspace_create');
    if (created.body.workspace.role !== 'Owner') throw new Error('workspace_owner_role_missing');
    checks.push('owner_can_create_self_serve_workspace');

    const listed = await fetchJson<{ workspaces: Array<{ workspaceId: string; name: string; role: WorkspaceRole }> }>(
      `${apiBaseUrl}/api/workspaces`,
      { headers: bearer },
    );
    requireOk(listed.response, 'workspace_list_after_create');
    if (listed.body.workspaces[0]?.workspaceId !== created.body.workspace.workspaceId) throw new Error('created_workspace_not_listed');
    checks.push('created_workspace_is_listed_for_owner');

    if (oidc.requests.discoveryRequests < 2 || oidc.requests.authorizationRequests !== 1 || oidc.requests.tokenRequests !== 1 || oidc.requests.userinfoRequests !== 1) {
      throw new Error('unexpected_oidc_request_counts');
    }
    checks.push('oidc_discovery_token_and_userinfo_endpoints_were_exercised');

    return {
      ok: true,
      checks,
      apiBaseUrl,
      oidcIssuer: oidc.issuer,
      user: callback.body.user,
      workspace: created.body.workspace,
      nativeCallbackUrl: redactedNativeCallbackUrl({
        rawToken: callback.body.token,
        apiBaseUrl,
        webBaseUrl,
        userId: callback.body.user.userId,
        email: callback.body.user.email,
        displayName: callback.body.user.displayName,
      }),
      oidcRequests: { ...oidc.requests },
    };
  } finally {
    await close(apiServer);
    await oidc.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runLocalOidcSmoke()
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
