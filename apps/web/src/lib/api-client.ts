import { readWebConfig } from '../config';
import { readSessionAdminToken } from './session-auth';

export interface CreatedDocument {
  docId: string;
  branchId: string;
  versionId: string;
  hash: string;
}

export interface ExportedMarkdown {
  filename: string;
  markdown: string;
}

export type VersionActorType = 'agent' | 'user' | 'system';
export type VersionOperation = 'create' | 'import' | 'autosave' | 'manual_save' | 'write' | 'edit' | 'rollback' | 'branch';

export interface BranchSummary {
  branchId: string;
  name: string;
  slug: string;
  headVersionId: string | null;
  createdFromVersionId: string | null;
  isArchived: boolean;
  headVersionNumber: number | null;
}

export interface DocumentSummary {
  docId: string;
  title: string;
  defaultBranchId: string | null;
  branches: BranchSummary[];
}

export interface VersionSummary {
  versionId: string;
  parentVersionId: string | null;
  versionNumber: number;
  hash: string;
  actorType: VersionActorType;
  actorId: string | null;
  operation: VersionOperation;
  createdAt: string;
}

export interface VersionDetail extends VersionSummary {
  branchId: string;
  markdown: string;
}

export interface BranchesResponse {
  branches: BranchSummary[];
}

export interface VersionsResponse {
  versions: VersionSummary[];
}

export interface RestoreVersionResponse {
  versionId: string;
  versionNumber: number;
  hash: string;
}

export interface ManualSaveVersionResponse {
  created: boolean;
  versionId: string;
  versionNumber: number;
  hash: string;
}

export interface LocalDocumentResponse {
  localDocId: string;
  displayName: string;
  absolutePath: string;
  roomName: string;
  hash: string;
  conflict: string | null;
  historyLoadError: string | null;
}

export type LocalVersionOperation = 'open' | 'manual_save' | 'pre_restore' | 'rollback' | 'conflict_recovery';

export interface LocalVersionSummary {
  versionId: string;
  versionNumber: number;
  operation: LocalVersionOperation;
  hash: string;
  createdAt: string;
}

export interface LocalVersionDetail extends LocalVersionSummary {
  markdown: string;
}

export interface LocalVersionsResponse {
  versions: LocalVersionSummary[];
}

export interface ReadDocumentResponse {
  versionId: string;
  hash: string;
  markdown: string;
}

export interface DocumentAccessResponse {
  canRead: boolean;
  canWrite: boolean;
  actorType: 'agent' | 'user';
  grantId?: string;
  role?: AccessGrantRole;
}

export interface AgentTokenSummary {
  tokenId: string;
  name: string;
  canRead: boolean;
  canWrite: boolean;
  expiresAt: string | null;
  createdAt: string;
}

export interface CreatedAgentToken {
  tokenId: string;
  name: string;
  canRead: boolean;
  canWrite: boolean;
  expiresAt: string | null;
  token: string;
}

export interface AgentTokensResponse {
  tokens: AgentTokenSummary[];
}

export type AccessGrantRole = 'view' | 'edit';
export type ShareLinkRole = AccessGrantRole;

export interface AccessSessionSummary {
  sessionId: string;
  clientKind: AccessClientKind | 'daemon';
  displayName: string;
  color: string;
  lastBranchId: string | null;
  lastSeenAt: string | null;
  grantId?: string | null;
  role?: 'host' | AccessGrantRole;
}

export interface AccessGrantSummary {
  grantId: string;
  role: AccessGrantRole;
  branchId: string;
  branchName: string;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  sessions: AccessSessionSummary[];
}

export interface CreatedAccessGrant {
  grantId: string;
  branchId: string;
  role: AccessGrantRole;
  expiresAt: string | null;
  createdAt: string;
  token: string;
}

export interface AccessGrantsResponse {
  grants: AccessGrantSummary[];
  sessions?: AccessSessionSummary[];
}

export type AccessClientKind = 'browser' | 'agent' | 'api';
export type RelayClientKind = 'browser' | 'daemon' | 'agent';

export interface RelayAccessResponse {
  relayRoomId: string;
  grantId: string;
  role: AccessGrantRole;
  canRead: boolean;
  canWrite: boolean;
  hostOnline: boolean;
  hostSessionId: string | null;
  sharedRevision: number;
  lastSharedHash: string | null;
  yjsStateBase64: string | null;
  markdown: string;
  cacheUpdatedAt: string;
  ephemeralCacheExpiresAt: string;
  stale: boolean;
  suggestedFilename: string;
}

export interface CreatedRelaySession {
  grantId: string;
  sessionId: string;
  displayName: string;
  color: string;
  role: AccessGrantRole;
  canRead: boolean;
  canWrite: boolean;
}

export interface RelayShareState {
  localPath: string | null;
  relayRoomId: string | null;
  hostOnline: boolean;
  hostSessionId: string | null;
  sharedRevision: number | null;
  lastSharedHash: string | null;
  links: Array<{
    grantId: string;
    relayRoomId: string;
    role: AccessGrantRole;
    label: string | null;
    canCopyExistingUrl: boolean;
    revokedAt: string | null;
    expiresAt: string | null;
    createdAt: string;
    activeSessionCount: number;
    lastCopiedAt: string | null;
  }>;
  sessions: Array<{
    sessionId: string;
    grantId: string | null;
    clientKind: RelayClientKind;
    displayName: string;
    role: 'host' | AccessGrantRole;
    lastSeenAt: string;
  }>;
}

export interface CreatedRelayAccessGrant {
  grantId: string;
  relayRoomId: string;
  role: AccessGrantRole;
  token: string;
  url: string;
  expiresAt: string | null;
  createdAt: string;
}

export interface CreatedAccessSession {
  grantId: string;
  sessionId: string;
  displayName: string;
  color: string;
  role: AccessGrantRole;
  canRead: boolean;
  canWrite: boolean;
}

export interface BranchSummaryAccess {
  canRead: boolean;
  canWrite: boolean;
  canManageAccess: boolean;
  canManageVersions: boolean;
  canSwitchBranches: boolean;
  actorType: 'agent' | 'user';
  grantId?: string;
  role?: AccessGrantRole;
}

export interface BranchSummaryResponse {
  docId: string;
  branchId: string;
  title: string;
  branchName: string;
  branchSlug: string;
  access: BranchSummaryAccess;
}

export interface ShareLinkSummary {
  linkId: string;
  role: ShareLinkRole;
  expiresAt: string | null;
  createdAt: string;
}

export interface CreatedShareLink {
  linkId: string;
  role: ShareLinkRole;
  expiresAt: string | null;
  token: string;
}

export interface ShareLinksResponse {
  links: ShareLinkSummary[];
}

export interface MarklabWebApiOptions {
  apiUrl?: string;
  adminToken?: string | null;
  documentToken?: string | null;
  localDaemonToken?: string | null;
}

function trimQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed
      .slice(1, -1)
      .replace(/\\"/gu, '"')
      .replace(/\\\\/gu, '\\');
  }
  return trimmed;
}

export function parseContentDispositionFilename(disposition: string | null): string | null {
  if (!disposition) return null;

  const filenameMatch = disposition.match(/(?:^|;)\s*filename=("[^"]*(?:\\"[^"]*)*"|[^;]+)/iu);
  if (!filenameMatch) return null;

  const [, rawFilename] = filenameMatch;
  if (!rawFilename) return null;

  const filename = trimQuotes(rawFilename);
  return filename.length > 0 ? filename : null;
}

async function requireJsonResponse<T>(response: Response, action: string): Promise<T> {
  if (response.ok) return (await response.json()) as T;

  const body = await response.text();
  throw new Error(`${action}_failed:${response.status}:${body}`);
}

function currentUrlDocumentToken(): string | null {
  if (typeof window === 'undefined') return null;
  const token = new URLSearchParams(window.location.search).get('token');
  return token && token.trim() ? token : null;
}

const localDaemonTokenKey = 'marklab.localDaemonToken.v1';

function currentUrlLocalDaemonToken(): string | null {
  if (typeof window === 'undefined') return null;
  const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash;
  if (!hash) return null;
  const params = new URLSearchParams(hash);
  const token = params.get('token') ?? params.get('localToken') ?? params.get('localDaemonToken');
  if (!token?.trim()) return null;

  window.sessionStorage.setItem(localDaemonTokenKey, token);
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  return token;
}

export function readLocalDaemonToken(): string | null {
  if (typeof window === 'undefined') return null;
  return currentUrlLocalDaemonToken() ?? window.sessionStorage.getItem(localDaemonTokenKey);
}

function withBearerToken(headers: HeadersInit, token: string | null): HeadersInit {
  if (!token) return headers;
  return { ...headers, Authorization: `Bearer ${token}` };
}

export class MarklabWebApi {
  private readonly apiUrl: string;
  private readonly adminToken: string | null | undefined;
  private readonly documentToken: string | null | undefined;
  private readonly localDaemonToken: string | null | undefined;

  constructor(input: string | MarklabWebApiOptions = {}) {
    const options = typeof input === 'string' ? { apiUrl: input } : input;
    this.apiUrl = options.apiUrl ?? readWebConfig().apiUrl;
    this.adminToken = options.adminToken;
    this.documentToken = options.documentToken;
    this.localDaemonToken = options.localDaemonToken;
  }

  private resolvedAdminToken(): string | null {
    return this.adminToken === undefined ? readSessionAdminToken() : this.adminToken;
  }

  private resolvedDocumentToken(): string | null {
    if (this.documentToken !== undefined) return this.documentToken;
    return currentUrlDocumentToken() ?? this.resolvedAdminToken();
  }

  private adminHeaders(headers: HeadersInit = {}): HeadersInit {
    return withBearerToken(headers, this.resolvedAdminToken());
  }

  private documentHeaders(headers: HeadersInit = {}): HeadersInit {
    return withBearerToken(headers, this.resolvedDocumentToken());
  }

  private resolvedLocalDaemonToken(): string | null {
    if (this.localDaemonToken !== undefined) return this.localDaemonToken;
    return readLocalDaemonToken();
  }

  private localHeaders(headers: HeadersInit = {}): HeadersInit {
    return withBearerToken(headers, this.resolvedLocalDaemonToken());
  }

  async createBlankDoc(title: string): Promise<CreatedDocument> {
    const response = await fetch(`${this.apiUrl}/api/docs`, {
      method: 'POST',
      headers: this.adminHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ title }),
    });
    return requireJsonResponse<CreatedDocument>(response, 'create_doc');
  }

  async importMarkdown(title: string, markdown: string): Promise<CreatedDocument> {
    const response = await fetch(`${this.apiUrl}/api/docs/import`, {
      method: 'POST',
      headers: this.adminHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ title, markdown }),
    });
    return requireJsonResponse<CreatedDocument>(response, 'import_doc');
  }

  async readDocument(docId: string, branchId: string): Promise<ReadDocumentResponse> {
    const response = await fetch(
      `${this.apiUrl}/api/docs/${encodeURIComponent(docId)}/branches/${encodeURIComponent(branchId)}/read`,
      { headers: this.documentHeaders() },
    );
    return requireJsonResponse<ReadDocumentResponse>(response, 'read_doc');
  }

  async getDocumentAccess(docId: string, branchId: string): Promise<DocumentAccessResponse> {
    const response = await fetch(
      `${this.apiUrl}/api/docs/${encodeURIComponent(docId)}/branches/${encodeURIComponent(branchId)}/access`,
      { headers: this.documentHeaders() },
    );
    return requireJsonResponse<DocumentAccessResponse>(response, 'document_access');
  }

  async exportMarkdown(docId: string, branchId: string): Promise<ExportedMarkdown> {
    const response = await fetch(
      `${this.apiUrl}/api/docs/${encodeURIComponent(docId)}/branches/${encodeURIComponent(branchId)}/export.md`,
      { headers: this.documentHeaders() },
    );
    const body = await response.text();
    if (!response.ok) throw new Error(`export_failed:${response.status}:${body}`);

    return {
      filename: parseContentDispositionFilename(response.headers.get('Content-Disposition')) ?? 'document.md',
      markdown: body,
    };
  }

  async getDocument(docId: string): Promise<DocumentSummary> {
    const response = await fetch(`${this.apiUrl}/api/docs/${encodeURIComponent(docId)}`, {
      headers: this.documentHeaders(),
    });
    return requireJsonResponse<DocumentSummary>(response, 'request');
  }

  async listBranches(docId: string): Promise<BranchesResponse> {
    const response = await fetch(`${this.apiUrl}/api/docs/${encodeURIComponent(docId)}/branches`, {
      headers: this.documentHeaders(),
    });
    return requireJsonResponse<BranchesResponse>(response, 'request');
  }

  async getBranchSummary(docId: string, branchId: string): Promise<BranchSummaryResponse> {
    const response = await fetch(
      `${this.apiUrl}/api/docs/${encodeURIComponent(docId)}/branches/${encodeURIComponent(branchId)}/summary`,
      { headers: this.documentHeaders() },
    );
    return requireJsonResponse<BranchSummaryResponse>(response, 'branch_summary');
  }

  async listVersions(docId: string, branchId: string): Promise<VersionsResponse> {
    const response = await fetch(
      `${this.apiUrl}/api/docs/${encodeURIComponent(docId)}/branches/${encodeURIComponent(branchId)}/versions`,
      { headers: this.documentHeaders() },
    );
    return requireJsonResponse<VersionsResponse>(response, 'request');
  }

  async showVersion(docId: string, versionId: string): Promise<VersionDetail> {
    const response = await fetch(`${this.apiUrl}/api/docs/${encodeURIComponent(docId)}/versions/${encodeURIComponent(versionId)}`, {
      headers: this.documentHeaders(),
    });
    return requireJsonResponse<VersionDetail>(response, 'request');
  }

  async restoreVersion(docId: string, branchId: string, versionId: string): Promise<RestoreVersionResponse> {
    const response = await fetch(
      `${this.apiUrl}/api/docs/${encodeURIComponent(docId)}/branches/${encodeURIComponent(branchId)}/restore`,
      {
        method: 'POST',
        headers: this.documentHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ versionId }),
      },
    );
    return requireJsonResponse<RestoreVersionResponse>(response, 'request');
  }

  async manualSaveVersion(docId: string, branchId: string): Promise<ManualSaveVersionResponse> {
    const response = await fetch(
      `${this.apiUrl}/api/docs/${encodeURIComponent(docId)}/branches/${encodeURIComponent(branchId)}/versions/manual-save`,
      {
        method: 'POST',
        headers: this.documentHeaders({ 'Content-Type': 'application/json' }),
      },
    );
    return requireJsonResponse<ManualSaveVersionResponse>(response, 'manual_save');
  }

  async autosaveVersion(docId: string, branchId: string): Promise<ManualSaveVersionResponse> {
    const response = await fetch(
      `${this.apiUrl}/api/docs/${encodeURIComponent(docId)}/branches/${encodeURIComponent(branchId)}/versions/autosave`,
      {
        method: 'POST',
        headers: this.documentHeaders({ 'Content-Type': 'application/json' }),
      },
    );
    return requireJsonResponse<ManualSaveVersionResponse>(response, 'autosave');
  }

  async getLocalDocument(): Promise<LocalDocumentResponse> {
    const response = await fetch(`${this.apiUrl}/api/local/document`, { headers: this.localHeaders() });
    return requireJsonResponse<LocalDocumentResponse>(response, 'local_document');
  }

  async flushLocalDocument(): Promise<LocalDocumentResponse> {
    const response = await fetch(`${this.apiUrl}/api/local/flush`, {
      method: 'POST',
      headers: this.localHeaders({ 'Content-Type': 'application/json' }),
    });
    return requireJsonResponse<LocalDocumentResponse>(response, 'local_flush');
  }

  async listLocalVersions(): Promise<LocalVersionsResponse> {
    const response = await fetch(`${this.apiUrl}/api/local/versions`, { headers: this.localHeaders() });
    return requireJsonResponse<LocalVersionsResponse>(response, 'local_versions');
  }

  async showLocalVersion(versionId: string): Promise<LocalVersionDetail> {
    const response = await fetch(`${this.apiUrl}/api/local/versions/${encodeURIComponent(versionId)}`, {
      headers: this.localHeaders(),
    });
    return requireJsonResponse<LocalVersionDetail>(response, 'local_version');
  }

  async manualSaveLocalVersion(): Promise<ManualSaveVersionResponse> {
    const response = await fetch(`${this.apiUrl}/api/local/versions/manual-save`, {
      method: 'POST',
      headers: this.localHeaders({ 'Content-Type': 'application/json' }),
    });
    return requireJsonResponse<ManualSaveVersionResponse>(response, 'local_manual_save');
  }

  async restoreLocalVersion(versionId: string): Promise<RestoreVersionResponse> {
    const response = await fetch(`${this.apiUrl}/api/local/restore`, {
      method: 'POST',
      headers: this.localHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ versionId }),
    });
    return requireJsonResponse<RestoreVersionResponse>(response, 'local_restore');
  }

  async getLocalShareState(): Promise<RelayShareState> {
    const response = await fetch(`${this.apiUrl}/api/local/share-state`, { headers: this.localHeaders() });
    return requireJsonResponse<RelayShareState>(response, 'local_share_state');
  }

  async createLocalRelayAccessGrant(input: { role: AccessGrantRole }): Promise<CreatedRelayAccessGrant> {
    const response = await fetch(`${this.apiUrl}/api/local/access-grants`, {
      method: 'POST',
      headers: this.localHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ role: input.role }),
    });
    return requireJsonResponse<CreatedRelayAccessGrant>(response, 'create_local_relay_access_grant');
  }

  async revokeLocalRelayAccessGrant(grantId: string): Promise<void> {
    const response = await fetch(`${this.apiUrl}/api/local/access-grants/${encodeURIComponent(grantId)}`, {
      method: 'DELETE',
      headers: this.localHeaders(),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`revoke_local_relay_access_grant_failed:${response.status}:${body}`);
    }
  }

  async getRelayAccess(relayRoomId: string, token: string): Promise<RelayAccessResponse> {
    const url = new URL(`${this.apiUrl}/api/relay/rooms/${encodeURIComponent(relayRoomId)}/access`);
    url.searchParams.set('token', token);
    const response = await fetch(url.toString());
    return requireJsonResponse<RelayAccessResponse>(response, 'relay_access');
  }

  async createRelaySession(
    relayRoomId: string,
    input: { token: string; clientId: string; clientKind: RelayClientKind; displayName: string },
  ): Promise<CreatedRelaySession> {
    const response = await fetch(`${this.apiUrl}/api/relay/rooms/${encodeURIComponent(relayRoomId)}/access-sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    return requireJsonResponse<CreatedRelaySession>(response, 'relay_session');
  }

  async createAccessGrant(
    docId: string,
    branchId: string,
    input: { role: AccessGrantRole; expiresAt?: string | null },
  ): Promise<CreatedAccessGrant> {
    const response = await fetch(
      `${this.apiUrl}/api/docs/${encodeURIComponent(docId)}/branches/${encodeURIComponent(branchId)}/access-grants`,
      {
        method: 'POST',
        headers: this.documentHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ role: input.role, expiresAt: input.expiresAt ?? null }),
      },
    );
    return requireJsonResponse<CreatedAccessGrant>(response, 'create_access_grant');
  }

  async listAccessGrants(docId: string, branchId: string): Promise<AccessGrantsResponse> {
    const response = await fetch(
      `${this.apiUrl}/api/docs/${encodeURIComponent(docId)}/branches/${encodeURIComponent(branchId)}/access-grants`,
      { headers: this.documentHeaders() },
    );
    return requireJsonResponse<AccessGrantsResponse>(response, 'list_access_grants');
  }

  async revokeAccessGrant(grantId: string): Promise<void> {
    const response = await fetch(`${this.apiUrl}/api/access-grants/${encodeURIComponent(grantId)}`, {
      method: 'DELETE',
      headers: this.documentHeaders(),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`revoke_access_grant_failed:${response.status}:${body}`);
    }
  }

  async createAccessSession(
    docId: string,
    branchId: string,
    input: { clientId: string; clientKind: AccessClientKind; displayName: string },
  ): Promise<CreatedAccessSession> {
    const response = await fetch(
      `${this.apiUrl}/api/docs/${encodeURIComponent(docId)}/branches/${encodeURIComponent(branchId)}/access-sessions`,
      {
        method: 'POST',
        headers: this.documentHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(input),
      },
    );
    return requireJsonResponse<CreatedAccessSession>(response, 'create_access_session');
  }

  async createAgentToken(
    docId: string,
    branchId: string,
    input: { name: string; canWrite: boolean },
  ): Promise<CreatedAgentToken> {
    const response = await fetch(
      `${this.apiUrl}/api/docs/${encodeURIComponent(docId)}/branches/${encodeURIComponent(branchId)}/agent-tokens`,
      {
        method: 'POST',
        headers: this.adminHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ name: input.name, canWrite: input.canWrite }),
      },
    );
    return requireJsonResponse<CreatedAgentToken>(response, 'create_agent_token');
  }

  async listAgentTokens(docId: string, branchId: string): Promise<AgentTokensResponse> {
    const response = await fetch(
      `${this.apiUrl}/api/docs/${encodeURIComponent(docId)}/branches/${encodeURIComponent(branchId)}/agent-tokens`,
      { headers: this.adminHeaders() },
    );
    return requireJsonResponse<AgentTokensResponse>(response, 'list_agent_tokens');
  }

  async revokeAgentToken(tokenId: string): Promise<void> {
    const response = await fetch(`${this.apiUrl}/api/agent-tokens/${encodeURIComponent(tokenId)}`, {
      method: 'DELETE',
      headers: this.adminHeaders(),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`revoke_agent_token_failed:${response.status}:${body}`);
    }
  }

  async createShareLink(docId: string, branchId: string, input: { role: ShareLinkRole }): Promise<CreatedShareLink> {
    const response = await fetch(
      `${this.apiUrl}/api/docs/${encodeURIComponent(docId)}/branches/${encodeURIComponent(branchId)}/share-links`,
      {
        method: 'POST',
        headers: this.adminHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ role: input.role }),
      },
    );
    return requireJsonResponse<CreatedShareLink>(response, 'create_share_link');
  }

  async listShareLinks(docId: string, branchId: string): Promise<ShareLinksResponse> {
    const response = await fetch(
      `${this.apiUrl}/api/docs/${encodeURIComponent(docId)}/branches/${encodeURIComponent(branchId)}/share-links`,
      { headers: this.adminHeaders() },
    );
    return requireJsonResponse<ShareLinksResponse>(response, 'list_share_links');
  }

  async revokeShareLink(linkId: string): Promise<void> {
    const response = await fetch(`${this.apiUrl}/api/share-links/${encodeURIComponent(linkId)}`, {
      method: 'DELETE',
      headers: this.adminHeaders(),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`revoke_share_link_failed:${response.status}:${body}`);
    }
  }
}
