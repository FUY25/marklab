import type {
  CreatedRelayAccessGrant,
  RelayAccessSessionIdentity,
  RelayAccessRole,
  RelayClientKind,
  RelayRoom,
  RelayRouteService,
  RelayShareState,
  VerifiedRelayAccess,
} from './relay-room-service';

export interface RemoteRelayRoomServiceOptions {
  publicApiUrl: string;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, '');
}

function encodeBase64(value: Uint8Array | null | undefined): string | null {
  return value ? Buffer.from(value).toString('base64') : null;
}

function decodeBase64(value: string | null | undefined): Uint8Array | null {
  return value ? new Uint8Array(Buffer.from(value, 'base64')) : null;
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  const body = await response.text();
  const json = body ? JSON.parse(body) : null;
  if (!response.ok) {
    const message =
      json && typeof json === 'object' && 'error' in json && typeof json.error === 'string'
        ? json.error
        : `remote_relay_http_${response.status}`;
    throw new Error(message);
  }
  return json as T;
}

export class RemoteRelayRoomService implements RelayRouteService {
  private readonly publicApiUrl: string;
  private readonly hostTokensByRoom = new Map<string, string>();
  private readonly roomIdsByGrant = new Map<string, string>();
  private readonly tokensByGrant = new Map<string, string>();

  constructor(options: RemoteRelayRoomServiceOptions) {
    this.publicApiUrl = trimTrailingSlash(options.publicApiUrl);
  }

  private apiUrl(path: string): string {
    return `${this.publicApiUrl}${path}`;
  }

  private hostToken(relayRoomId: string): string {
    const token = this.hostTokensByRoom.get(relayRoomId);
    if (!token) throw new Error('relay_host_token_not_available');
    return token;
  }

  rememberHostToken(relayRoomId: string, hostAuthToken: string): void {
    this.hostTokensByRoom.set(relayRoomId, hostAuthToken);
  }

  async verifyHost(relayRoomId: string, hostToken: string | undefined): Promise<void> {
    if (!hostToken || hostToken !== this.hostToken(relayRoomId)) throw new Error('forbidden');
  }

  async createRoom(input: {
    hostSessionId?: string | null;
    hostAuthToken?: string | null;
    lastEphemeralYjsState?: Uint8Array | null;
    lastSharedHash?: string | null;
  } = {}): Promise<RelayRoom> {
    if (!input.hostAuthToken) throw new Error('relay_host_token_not_available');
    const response = await fetch(this.apiUrl('/api/relay/rooms'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hostSessionId: input.hostSessionId ?? null,
        hostAuthToken: input.hostAuthToken,
        lastEphemeralYjsStateBase64: encodeBase64(input.lastEphemeralYjsState),
        lastSharedHash: input.lastSharedHash ?? null,
      }),
    });
    const room = await readJsonResponse<{
      relayRoomId: string;
      hostSessionId: string | null;
      state: RelayRoom['state'];
      sharedRevision: number;
      lastSharedHash: string | null;
    }>(response);
    this.hostTokensByRoom.set(room.relayRoomId, input.hostAuthToken);
    const now = new Date().toISOString();
    return {
      ...room,
      lastEphemeralYjsState: input.lastEphemeralYjsState ?? null,
      createdAt: now,
      updatedAt: now,
    };
  }

  async createAccessGrant(input: {
    relayRoomId: string;
    role: RelayAccessRole;
    expiresAt?: string | null;
  }): Promise<CreatedRelayAccessGrant> {
    const response = await fetch(this.apiUrl(`/api/relay/rooms/${encodeURIComponent(input.relayRoomId)}/access-grants`), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.hostToken(input.relayRoomId)}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ role: input.role, expiresAt: input.expiresAt ?? null }),
    });
    const grant = await readJsonResponse<CreatedRelayAccessGrant>(response);
    this.roomIdsByGrant.set(grant.grantId, grant.relayRoomId);
    this.tokensByGrant.set(grant.grantId, grant.token);
    return grant;
  }

  async verifyAccess(input: {
    relayRoomId: string;
    token: string | undefined;
    operation: 'read' | 'write';
  }): Promise<VerifiedRelayAccess> {
    if (!input.token) throw new Error('forbidden');
    const url = new URL(this.apiUrl(`/api/relay/rooms/${encodeURIComponent(input.relayRoomId)}/access`));
    url.searchParams.set('token', input.token);
    const response = await fetch(url);
    const access = await readJsonResponse<{
      relayRoomId: string;
      grantId: string;
      role: RelayAccessRole;
      canRead: boolean;
      canWrite: boolean;
      hostOnline: boolean;
      hostSessionId: string | null;
      sharedRevision: number;
      lastSharedHash: string | null;
      yjsStateBase64: string | null;
      cacheUpdatedAt: string;
      ephemeralCacheExpiresAt: string;
      stale: boolean;
    }>(response);
    if (input.operation === 'write' && !access.canWrite) throw new Error('forbidden');
    this.tokensByGrant.set(access.grantId, input.token);
    return {
      ...access,
      canView: access.canRead,
      canEdit: access.canWrite,
      lastEphemeralYjsState: decodeBase64(access.yjsStateBase64),
    };
  }

  async createOrUpdateSession(input: {
    grantId: string;
    relayRoomId: string;
    clientId: string;
    clientKind: RelayClientKind;
    displayName: string;
  }): Promise<RelayAccessSessionIdentity> {
    const token = this.tokensByGrant.get(input.grantId);
    if (!token) throw new Error('forbidden');
    const response = await fetch(this.apiUrl(`/api/relay/rooms/${encodeURIComponent(input.relayRoomId)}/access-sessions`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token,
        clientId: input.clientId,
        clientKind: input.clientKind,
        displayName: input.displayName,
      }),
    });
    const session = await readJsonResponse<{
      grantId: string | null;
      sessionId: string;
      displayName: string;
      color: string;
      role: RelayAccessRole | 'host';
    }>(response);
    const now = new Date().toISOString();
    return {
      grantId: session.grantId,
      relayRoomId: input.relayRoomId,
      sessionId: session.sessionId,
      clientId: input.clientId,
      clientKind: input.clientKind,
      displayName: session.displayName,
      color: session.color,
      role: session.role,
      createdAt: now,
      lastSeenAt: now,
    };
  }

  async listShareState(relayRoomId: string, localPath: string | null = null): Promise<RelayShareState> {
    const response = await fetch(this.apiUrl(`/api/relay/rooms/${encodeURIComponent(relayRoomId)}/share-state`), {
      headers: { Authorization: `Bearer ${this.hostToken(relayRoomId)}` },
    });
    const shareState = await readJsonResponse<RelayShareState>(response);
    for (const link of shareState.links) this.roomIdsByGrant.set(link.grantId, link.relayRoomId);
    return { ...shareState, localPath };
  }

  async revokeAccessGrant(grantId: string): Promise<{ grantId: string; relayRoomId: string }> {
    const relayRoomId = this.roomIdsByGrant.get(grantId);
    if (!relayRoomId) throw new Error('relay_access_grant_not_found');
    const response = await fetch(
      this.apiUrl(`/api/relay/rooms/${encodeURIComponent(relayRoomId)}/access-grants/${encodeURIComponent(grantId)}`),
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${this.hostToken(relayRoomId)}` },
      },
    );
    if (response.status === 204) return { grantId, relayRoomId };
    await readJsonResponse(response);
    return { grantId, relayRoomId };
  }

  async markHostOffline(relayRoomId: string): Promise<RelayRoom | null> {
    const response = await fetch(this.apiUrl(`/api/relay/rooms/${encodeURIComponent(relayRoomId)}/host-offline`), {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.hostToken(relayRoomId)}` },
    });
    await readJsonResponse(response);
    return null;
  }

  async getRoom(relayRoomId: string): Promise<RelayRoom> {
    const shareState = await this.listShareState(relayRoomId);
    const now = new Date().toISOString();
    return {
      relayRoomId,
      hostSessionId: shareState.hostSessionId,
      state: shareState.hostOnline ? 'host_online' : 'host_offline',
      lastEphemeralYjsState: null,
      lastSharedHash: shareState.lastSharedHash,
      sharedRevision: shareState.sharedRevision ?? 0,
      createdAt: now,
      updatedAt: now,
    };
  }
}

export function createRemoteRelayRoomService(options: RemoteRelayRoomServiceOptions): RemoteRelayRoomService {
  return new RemoteRelayRoomService(options);
}
