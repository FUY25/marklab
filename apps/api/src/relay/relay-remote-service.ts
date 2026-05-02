import type {
  CreatedRelayAccessGrant,
  RelayAccessRole,
  RelayRoom,
  RelayRoomHostService,
  RelayShareState,
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

export class RemoteRelayRoomService implements RelayRoomHostService {
  private readonly publicApiUrl: string;
  private readonly hostTokensByRoom = new Map<string, string>();
  private readonly roomIdsByGrant = new Map<string, string>();

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
    return grant;
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
}

export function createRemoteRelayRoomService(options: RemoteRelayRoomServiceOptions): RemoteRelayRoomService {
  return new RemoteRelayRoomService(options);
}
