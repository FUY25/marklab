import {
  DEFAULT_PROVIDER_TOKEN_POLICY,
  type ProviderTokenPolicy,
} from '@marklab/shared/src/provider-token-policy';

const millisecondsPerSecond = 1000;

export const MARKLAB_API_URL = import.meta.env.VITE_MARKLAB_API_URL?.replace(/\/+$/u, '') ?? '';

export type CollabClientKind = 'browser';
export type CollabMode = 'view' | 'edit';
export type ProviderAuthorization = 'full' | 'read-only';

export interface ProviderClientToken {
  docId: string;
  url: string;
  baseUrl: string;
  token: string;
  authorization: ProviderAuthorization;
}

export interface ProviderSessionIdentity {
  sessionId: string;
  actorType: 'agent' | 'user';
  actorId: string;
  displayName: string;
  isGuest: boolean;
}

export interface IssuedProviderToken {
  providerDocId: string;
  sessionId: string;
  authorization: ProviderAuthorization;
  validForSeconds: number;
  issuedAt: string;
  expiresAt: string;
  clientToken: ProviderClientToken;
  sessionIdentity?: ProviderSessionIdentity;
}

export interface CollabSessionRequest {
  docId: string;
  branchId: string;
  mode: CollabMode;
  displayName: string;
  token?: string | undefined;
}

export interface ViewCollabSession {
  mode: 'view';
  session: {
    sessionId: string;
    clientKind: string;
    displayName: string;
  };
  document: {
    docId: string;
    branchId: string;
    versionId: string | null;
    versionNumber: number | null;
    hash: string;
    markdown: string;
  };
}

export interface EditCollabSession {
  mode: 'edit';
  session: {
    sessionId: string;
    clientKind: string;
    displayName: string;
    refreshToken: string;
  };
  providerToken: IssuedProviderToken;
}

export type CollabSession = ViewCollabSession | EditCollabSession;

export interface ActiveEditSession {
  docId: string;
  branchId: string;
  sessionId: string;
  refreshToken: string;
  providerToken: IssuedProviderToken;
}

export interface CollabSessionClientOptions {
  apiUrl?: string;
  fetcher?: typeof fetch;
}

export class CollabSessionError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.name = 'CollabSessionError';
    this.status = status;
    this.code = code;
  }
}

export function collabSessionPath(input: Pick<CollabSessionRequest, 'docId' | 'branchId'>): string {
  return `/api/docs/${encodeURIComponent(input.docId)}/branches/${encodeURIComponent(input.branchId)}/collab/session`;
}

export function providerTokenRefreshPath(input: { docId: string; branchId: string; sessionId: string }): string {
  return `${collabSessionPath(input)}/${encodeURIComponent(input.sessionId)}/provider-token/refresh`;
}

function withApiUrl(apiUrl: string, path: string): string {
  return `${apiUrl.replace(/\/+$/u, '')}${path}`;
}

function withQueryToken(path: string, token: string | undefined): string {
  if (!token) return path;
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}token=${encodeURIComponent(token)}`;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const body = await readJson(response);
  if (!response.ok) {
    const code =
      body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
        ? body.error
        : `http_${response.status}`;
    throw new CollabSessionError(response.status, code);
  }
  return body;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid_${label}`);
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`invalid_${label}`);
  return value;
}

function parseProviderAuthorization(value: unknown, label: string): ProviderAuthorization {
  const authorization = requireString(value, label);
  if (authorization !== 'full' && authorization !== 'read-only') throw new Error(`invalid_${label}`);
  return authorization;
}

function optionalString(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value === 'string') return value;
  throw new Error(`invalid_${label}`);
}

function optionalNumber(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (typeof value === 'number') return value;
  throw new Error(`invalid_${label}`);
}

function parseProviderToken(value: unknown): IssuedProviderToken {
  const token = requireRecord(value, 'provider_token');
  const clientToken = requireRecord(token.clientToken, 'client_token');
  const validForSeconds = typeof token.validForSeconds === 'number' ? token.validForSeconds : Number(token.validForSeconds);
  if (!Number.isFinite(validForSeconds) || validForSeconds <= 0) throw new Error('invalid_provider_valid_for_seconds');

  return {
    providerDocId: requireString(token.providerDocId, 'provider_doc_id'),
    sessionId: requireString(token.sessionId, 'provider_session_id'),
    authorization: parseProviderAuthorization(token.authorization, 'provider_authorization'),
    validForSeconds,
    issuedAt: requireString(token.issuedAt, 'provider_issued_at'),
    expiresAt: requireString(token.expiresAt, 'provider_expires_at'),
    clientToken: {
      docId: requireString(clientToken.docId, 'client_token_doc_id'),
      url: requireString(clientToken.url, 'client_token_url'),
      baseUrl: requireString(clientToken.baseUrl, 'client_token_base_url'),
      token: requireString(clientToken.token, 'client_token_token'),
      authorization: parseProviderAuthorization(clientToken.authorization, 'client_token_authorization'),
    },
    ...(token.sessionIdentity ? { sessionIdentity: requireRecord(token.sessionIdentity, 'session_identity') as unknown as ProviderSessionIdentity } : {}),
  };
}

function parseCollabSession(value: unknown): CollabSession {
  const body = requireRecord(value, 'collab_session');
  const mode = requireString(body.mode, 'mode');
  const session = requireRecord(body.session, 'session');
  if (mode === 'view') {
    const document = requireRecord(body.document, 'document');
    return {
      mode,
      session: {
        sessionId: requireString(session.sessionId, 'session_id'),
        clientKind: requireString(session.clientKind, 'client_kind'),
        displayName: requireString(session.displayName, 'display_name'),
      },
      document: {
        docId: requireString(document.docId, 'document_doc_id'),
        branchId: requireString(document.branchId, 'document_branch_id'),
        versionId: optionalString(document.versionId, 'document_version_id'),
        versionNumber: optionalNumber(document.versionNumber, 'document_version_number'),
        hash: requireString(document.hash, 'document_hash'),
        markdown: requireString(document.markdown, 'document_markdown'),
      },
    };
  }
  if (mode === 'edit') {
    const providerToken = parseProviderToken(body.providerToken);
    if (providerToken.authorization !== 'full' || providerToken.clientToken.authorization !== 'full') {
      throw new Error('invalid_edit_provider_authorization');
    }
    return {
      mode,
      session: {
        sessionId: requireString(session.sessionId, 'session_id'),
        clientKind: requireString(session.clientKind, 'client_kind'),
        displayName: requireString(session.displayName, 'display_name'),
        refreshToken: requireString(session.refreshToken, 'refresh_token'),
      },
      providerToken,
    };
  }
  throw new Error('invalid_mode');
}

export function providerTokenRefreshDelayMs(
  providerToken: Pick<IssuedProviderToken, 'expiresAt'>,
  nowMs = Date.now(),
  policy: ProviderTokenPolicy = DEFAULT_PROVIDER_TOKEN_POLICY,
): number {
  const expiresAtMs = Date.parse(providerToken.expiresAt);
  if (!Number.isFinite(expiresAtMs)) throw new Error('invalid_provider_token_expiry');
  const refreshAtMs = expiresAtMs - policy.refreshMarginSeconds * millisecondsPerSecond;
  const refreshDelayMs = refreshAtMs - nowMs;
  if (refreshDelayMs > 0) return refreshDelayMs;
  return policy.refreshCheckIntervalSeconds * millisecondsPerSecond;
}

export function createCollabSessionClient(options: CollabSessionClientOptions = {}) {
  const apiUrl = options.apiUrl ?? MARKLAB_API_URL;
  const fetcher = options.fetcher ?? fetch;
  let activeEditSession: ActiveEditSession | null = null;

  async function createSession(request: CollabSessionRequest): Promise<CollabSession> {
    const path = withQueryToken(collabSessionPath(request), request.token);
    const response = await fetcher(withApiUrl(apiUrl, path), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: request.mode,
        clientKind: 'browser' satisfies CollabClientKind,
        displayName: request.displayName,
      }),
    });
    const session = parseCollabSession(await readJsonResponse(response));
    if (session.mode === 'edit') {
      activeEditSession = {
        docId: request.docId,
        branchId: request.branchId,
        sessionId: session.session.sessionId,
        refreshToken: session.session.refreshToken,
        providerToken: session.providerToken,
      };
    }
    return session;
  }

  async function refreshProviderToken(session: ActiveEditSession | null = activeEditSession): Promise<IssuedProviderToken> {
    if (!session) throw new Error('edit_session_not_started');
    const response = await fetcher(withApiUrl(apiUrl, providerTokenRefreshPath(session)), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: session.refreshToken }),
    });
    const body = requireRecord(await readJsonResponse(response), 'provider_token_refresh');
    const providerToken = parseProviderToken(body.providerToken);
    activeEditSession = { ...session, providerToken };
    return providerToken;
  }

  return {
    createSession,
    refreshProviderToken,
    getActiveEditSession: () => activeEditSession,
  };
}
