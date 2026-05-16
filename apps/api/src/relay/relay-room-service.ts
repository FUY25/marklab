import { randomBytes, timingSafeEqual } from 'node:crypto';
import { sha256Hex } from '@marklab/shared/src/hash';
import * as Y from 'yjs';
import type { DbPool } from '../db/client';
import { withTransaction } from '../db/client';
import { createHeadlessMilkdownRuntime } from '../services/milkdown-headless-runtime';

export type RelayHostState = 'host_online' | 'host_offline';
export type RelayRoomState = RelayHostState | 'starting' | 'ended';
export type RelayAccessRole = 'view' | 'edit';
export type RelayGrantRole = RelayAccessRole;
export type RelayClientKind = 'browser' | 'daemon' | 'agent';
export type RelayShareSessionRole = 'host' | RelayAccessRole;

export interface RelayRoom {
  relayRoomId: string;
  hostSessionId: string | null;
  state: RelayRoomState;
  lastEphemeralYjsState: Uint8Array | null;
  lastSharedHash: string | null;
  sharedRevision: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreatedRelayAccessGrant {
  grantId: string;
  relayRoomId: string;
  token: string;
  role: RelayAccessRole;
  expiresAt: string | null;
  createdAt: string;
}

export interface RelayAccessGrantSummary {
  grantId: string;
  relayRoomId: string;
  role: RelayAccessRole;
  label: string | null;
  canCopyExistingUrl: boolean;
  revokedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  activeSessionCount: number;
  lastCopiedAt: string | null;
}

export interface RelayAccessSessionIdentity {
  grantId: string | null;
  relayRoomId?: string;
  sessionId: string;
  clientId: string;
  clientKind: RelayClientKind;
  displayName: string;
  color: string;
  role: RelayShareSessionRole;
  createdAt: string;
  lastSeenAt: string;
}

export interface RelayShareSessionSummary {
  sessionId: string;
  grantId: string | null;
  clientKind: RelayClientKind;
  displayName: string;
  role: RelayShareSessionRole;
  lastSeenAt: string;
}

export interface RelayShareState {
  mode?: 'local' | 'relay-host' | 'relay-mirror';
  localPath: string | null;
  relayRoomId: string | null;
  hostOnline: boolean;
  hostSessionId: string | null;
  sharedRevision: number | null;
  lastSharedHash: string | null;
  links: RelayAccessGrantSummary[];
  sessions: RelayShareSessionSummary[];
}

export interface RelayCleanupResult {
  expiredGrants: number;
  staleSessions: number;
  expiredEphemeralRooms: number;
}

export interface RelayRoomHostService {
  rememberHostToken?(relayRoomId: string, hostAuthToken: string): void;
  getRoom?(relayRoomId: string): Promise<RelayRoom>;
  acceptSharedState?(input: {
    relayRoomId: string;
    yjsState: Uint8Array;
    sharedHash: string;
    expectedRevision?: number | null;
    expectedSharedHash?: string | null;
  }): Promise<RelayRoom>;
  createRoom(input?: {
    hostSessionId?: string | null;
    hostAuthToken?: string | null;
    lastEphemeralYjsState?: Uint8Array | null;
    lastSharedHash?: string | null;
  }): Promise<RelayRoom>;
  createAccessGrant(input: {
    relayRoomId: string;
    role: RelayAccessRole;
    expiresAt?: string | null;
  }): Promise<CreatedRelayAccessGrant>;
  listShareState(relayRoomId: string, localPath?: string | null): Promise<RelayShareState>;
  revokeAccessGrant(grantId: string): Promise<{ grantId: string; relayRoomId: string } | void>;
  markHostOffline(relayRoomId: string, hostSessionId?: string | null): Promise<RelayRoom | null>;
}

export interface RelayRouteService extends RelayRoomHostService {
  verifyHost(relayRoomId: string, hostToken: string | undefined): Promise<void>;
  verifyAccess(input: {
    relayRoomId: string;
    token: string | undefined;
    operation: 'read' | 'write';
  }): Promise<VerifiedRelayAccess>;
  createOrUpdateSession(input: {
    grantId: string;
    relayRoomId: string;
    clientId: string;
    clientKind: RelayClientKind;
    displayName: string;
  }): Promise<RelayAccessSessionIdentity>;
  revokeAccessGrant(grantId: string): Promise<{ grantId: string; relayRoomId: string }>;
}

export interface VerifiedRelayAccess {
  grantId: string;
  relayRoomId: string;
  role: RelayAccessRole;
  canRead: boolean;
  canWrite: boolean;
  canView: boolean;
  canEdit: boolean;
  hostOnline: boolean;
  hostSessionId: string | null;
  sharedRevision: number;
  lastSharedHash: string | null;
  lastEphemeralYjsState: Uint8Array | null;
  cacheUpdatedAt: string;
  ephemeralCacheExpiresAt: string;
  stale: boolean;
}

interface RelayRoomRow {
  id: string;
  host_session_id: string | null;
  host_auth_token_hash?: string | null;
  state: RelayRoomState;
  last_ephemeral_yjs_state?: Buffer | Uint8Array | null;
  last_shared_hash: string | null;
  shared_revision: number;
  created_at: Date | string;
  updated_at: Date | string;
}

interface RelayGrantRow {
  id: string;
  relay_room_id: string;
  role: RelayAccessRole;
  expires_at: Date | string | null;
  revoked_at: Date | string | null;
  created_at: Date | string;
  active_session_count?: number | string;
}

interface RelaySessionRow {
  id: string;
  grant_id: string | null;
  relay_room_id?: string;
  client_id: string;
  client_kind: RelayClientKind;
  display_name: string;
  color: string;
  role?: RelayShareSessionRole;
  created_at: Date | string;
  last_seen_at: Date | string;
}

function toIsoString(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function optionalBytes(value: Buffer | Uint8Array | null | undefined): Uint8Array | null {
  if (!value || value.byteLength === 0) return null;
  return new Uint8Array(value);
}

function relayRoomFromRow(row: RelayRoomRow): RelayRoom {
  return {
    relayRoomId: row.id,
    hostSessionId: row.host_session_id,
    state: row.state,
    lastEphemeralYjsState: optionalBytes(row.last_ephemeral_yjs_state),
    lastSharedHash: row.last_shared_hash,
    sharedRevision: Number(row.shared_revision),
    createdAt: toIsoString(row.created_at) ?? new Date().toISOString(),
    updatedAt: toIsoString(row.updated_at) ?? new Date().toISOString(),
  };
}

const relayMarkdownRuntime = createHeadlessMilkdownRuntime();

async function hashRelayYjsMarkdownState(yjsState: Uint8Array): Promise<string> {
  try {
    return (await relayMarkdownRuntime.serializeYjsState(yjsState)).hash;
  } catch {
    const validationDocument = new Y.Doc();
    try {
      Y.applyUpdate(validationDocument, yjsState);
      if (validationDocument.share.has('contents')) {
        return sha256Hex(validationDocument.getText('contents').toString());
      }
      if (validationDocument.share.has('prosemirror')) {
        return sha256Hex(validationDocument.getText('prosemirror').toString());
      }
    } catch {
      throw new Error('invalid_relay_yjs_state');
    } finally {
      validationDocument.destroy();
    }
    throw new Error('invalid_relay_yjs_state');
  }
}

function grantSummaryFromRow(row: RelayGrantRow): RelayAccessGrantSummary {
  return {
    grantId: row.id,
    relayRoomId: row.relay_room_id,
    role: row.role,
    label: null,
    canCopyExistingUrl: false,
    revokedAt: toIsoString(row.revoked_at),
    expiresAt: toIsoString(row.expires_at),
    createdAt: toIsoString(row.created_at) ?? new Date().toISOString(),
    activeSessionCount: Number(row.active_session_count ?? 0),
    lastCopiedAt: null,
  };
}

function isUsable(row: { expires_at?: Date | string | null; revoked_at?: Date | string | null }, now = Date.now()): boolean {
  if (row.revoked_at) return false;
  if (row.expires_at && new Date(row.expires_at).getTime() <= now) return false;
  return true;
}

function isExpired(expiresAt: string | null | undefined, nowMs = Date.now()): boolean {
  return Boolean(expiresAt && new Date(expiresAt).getTime() <= nowMs);
}

function isHostOnline(state: RelayRoomState): boolean {
  return state === 'host_online';
}

function relayEphemeralCacheTtlMs(): number {
  const configured = Number(process.env.MARKLAB_RELAY_EPHEMERAL_CACHE_TTL_MS ?? 300_000);
  return Number.isFinite(configured) && configured > 0 ? configured : 300_000;
}

function cacheExpiry(updatedAt: Date | string): string {
  return new Date(new Date(updatedAt).getTime() + relayEphemeralCacheTtlMs()).toISOString();
}

function isEphemeralCacheStale(state: RelayRoomState, updatedAt: Date | string): boolean {
  return !isHostOnline(state) || Date.now() > new Date(updatedAt).getTime() + relayEphemeralCacheTtlMs();
}

function colorForSession(grantId: string, clientId: string): string {
  return `#${sha256Hex(`${grantId}:${clientId}`).replace(/^sha256:/u, '').slice(0, 6)}`;
}

function sessionFromRow(row: RelaySessionRow): RelayAccessSessionIdentity {
  return {
    grantId: row.grant_id,
    sessionId: row.id,
    clientId: row.client_id,
    clientKind: row.client_kind,
    displayName: row.display_name,
    color: row.color,
    role: row.role ?? 'view',
    createdAt: toIsoString(row.created_at) ?? new Date().toISOString(),
    lastSeenAt: toIsoString(row.last_seen_at) ?? new Date().toISOString(),
  };
}

function shareSessionFromRow(row: RelaySessionRow): RelayShareSessionSummary {
  return {
    sessionId: row.id,
    grantId: row.grant_id,
    clientKind: row.client_kind,
    displayName: row.display_name,
    role: row.role ?? 'view',
    lastSeenAt: toIsoString(row.last_seen_at) ?? new Date().toISOString(),
  };
}

function hashesMatch(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.byteLength === expectedBuffer.byteLength && timingSafeEqual(actualBuffer, expectedBuffer);
}

export function generateRelayToken(): string {
  return `ml_relay_${randomBytes(32).toString('base64url')}`;
}

export function hashRelayToken(token: string): string {
  return sha256Hex(token);
}

function assertRoleCanWrite(role: RelayAccessRole): void {
  if (role !== 'edit') throw new Error('forbidden');
}

export class RelayRoomService {
  constructor(private readonly pool: DbPool) {}

  async createRoom(input: {
    hostSessionId?: string | null;
    hostAuthToken?: string | null;
    lastEphemeralYjsState?: Uint8Array | null;
    lastSharedHash?: string | null;
  } = {}): Promise<RelayRoom> {
    const lastSharedHash = input.lastEphemeralYjsState
      ? await hashRelayYjsMarkdownState(input.lastEphemeralYjsState)
      : (input.lastSharedHash ?? null);
    const result = await this.pool.query<RelayRoomRow>(
      `insert into relay_rooms
         (host_session_id, host_auth_token_hash, state, last_ephemeral_yjs_state, last_shared_hash, shared_revision)
       values ($1, $2, $3, $4, $5, 0)
       returning id, host_session_id, state, last_ephemeral_yjs_state, last_shared_hash, shared_revision, created_at, updated_at`,
      [
        input.hostSessionId ?? null,
        input.hostAuthToken ? hashRelayToken(input.hostAuthToken) : null,
        input.hostSessionId ? 'host_online' : 'host_offline',
        input.lastEphemeralYjsState ? Buffer.from(input.lastEphemeralYjsState) : null,
        lastSharedHash,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error('relay_room_insert_failed');
    return relayRoomFromRow(row);
  }

  async verifyHost(relayRoomId: string, hostToken: string | undefined): Promise<void> {
    if (!hostToken) throw new Error('forbidden');
    const result = await this.pool.query<{ host_auth_token_hash: string | null }>(
      `select host_auth_token_hash
         from relay_rooms
        where id = $1`,
      [relayRoomId],
    );
    const row = result.rows[0];
    if (!row) throw new Error('relay_room_not_found');
    if (!row.host_auth_token_hash || !hashesMatch(hashRelayToken(hostToken), row.host_auth_token_hash)) throw new Error('forbidden');
  }

  async getRoom(relayRoomId: string): Promise<RelayRoom> {
    const result = await this.pool.query<RelayRoomRow>(
      `select id, host_session_id, state, last_ephemeral_yjs_state, last_shared_hash, shared_revision, created_at, updated_at
         from relay_rooms
        where id = $1`,
      [relayRoomId],
    );
    const row = result.rows[0];
    if (!row) throw new Error('relay_room_not_found');
    return relayRoomFromRow(row);
  }

  async markHostOnline(
    relayRoomId: string,
    hostSessionId: string,
    input: { lastEphemeralYjsState?: Uint8Array | null; lastSharedHash?: string | null } = {},
  ): Promise<RelayRoom> {
    const result = await this.pool.query<RelayRoomRow>(
      `update relay_rooms
          set host_session_id = $2,
              state = 'host_online',
              host_offline_reason = null,
              last_ephemeral_yjs_state = coalesce($3, last_ephemeral_yjs_state),
              last_shared_hash = coalesce($4, last_shared_hash),
              ephemeral_last_updated_at = case when $3::bytea is null then ephemeral_last_updated_at else now() end,
              ephemeral_cache_expires_at = case when $3::bytea is null then ephemeral_cache_expires_at else now() + ($5::double precision * interval '1 second') end,
              updated_at = now()
        where id = $1
        returning id, host_session_id, state, last_ephemeral_yjs_state, last_shared_hash, shared_revision, created_at, updated_at`,
      [
        relayRoomId,
        hostSessionId,
        input.lastEphemeralYjsState ? Buffer.from(input.lastEphemeralYjsState) : null,
        input.lastSharedHash ?? null,
        relayEphemeralCacheTtlMs() / 1000,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error('relay_room_not_found');
    return relayRoomFromRow(row);
  }

  async markHostOffline(relayRoomId: string, hostSessionId?: string | null): Promise<RelayRoom | null> {
    const result = await this.pool.query<RelayRoomRow>(
      `update relay_rooms
          set state = 'host_offline',
              host_offline_reason = coalesce(host_offline_reason, 'host_offline'),
              updated_at = now()
        where id = $1
          and ($2::text is null or host_session_id = $2)
        returning id, host_session_id, state, last_ephemeral_yjs_state, last_shared_hash, shared_revision, created_at, updated_at`,
      [relayRoomId, hostSessionId ?? null],
    );
    const row = result.rows[0];
    return row ? relayRoomFromRow(row) : null;
  }

  async acceptSharedState(input: {
    relayRoomId: string;
    yjsState: Uint8Array;
    sharedHash: string;
    expectedRevision?: number | null;
    expectedSharedHash?: string | null;
  }): Promise<RelayRoom> {
    const sharedHash = await hashRelayYjsMarkdownState(input.yjsState);
    const params = [
      input.relayRoomId,
      Buffer.from(input.yjsState),
      sharedHash,
      input.expectedRevision ?? null,
      input.expectedSharedHash ?? null,
      relayEphemeralCacheTtlMs() / 1000,
    ];
    const result = await this.pool.query<RelayRoomRow>(
      `update relay_rooms
          set last_ephemeral_yjs_state = $2,
              last_shared_hash = $3,
              accepted_shared_revision = shared_revision + 1,
              accepted_shared_hash = $3,
              ephemeral_last_updated_at = now(),
              ephemeral_cache_expires_at = now() + ($6::double precision * interval '1 second'),
              shared_revision = shared_revision + 1,
              updated_at = now()
        where id = $1
          and state = 'host_online'
          and ($4::integer is null or shared_revision = $4)
          and ($5::text is null or coalesce(last_shared_hash, '') = $5)
        returning id, host_session_id, state, last_ephemeral_yjs_state, last_shared_hash, shared_revision, created_at, updated_at`,
      params,
    );
    const row = result.rows[0];
    if (!row) throw new Error('relay_shared_state_not_accepted');
    return relayRoomFromRow(row);
  }

  async createAccessGrant(input: {
    relayRoomId: string;
    role: RelayAccessRole;
    expiresAt?: string | null;
  }): Promise<CreatedRelayAccessGrant> {
    const token = generateRelayToken();
    const result = await this.pool.query<RelayGrantRow>(
      `insert into relay_access_grants
         (relay_room_id, token_hash, role, expires_at)
       values ($1, $2, $3, $4)
       returning id, relay_room_id, role, expires_at, revoked_at, created_at`,
      [input.relayRoomId, hashRelayToken(token), input.role, input.expiresAt ?? null],
    );
    const row = result.rows[0];
    if (!row) throw new Error('relay_access_grant_insert_failed');
    return {
      grantId: row.id,
      relayRoomId: row.relay_room_id,
      token,
      role: row.role,
      expiresAt: toIsoString(row.expires_at),
      createdAt: toIsoString(row.created_at) ?? new Date().toISOString(),
    };
  }

  async listAccessGrants(relayRoomId: string): Promise<RelayAccessGrantSummary[]> {
    const result = await this.pool.query<RelayGrantRow>(
      `select g.id,
              g.relay_room_id,
              g.role,
              g.expires_at,
              g.revoked_at,
              g.created_at,
              count(s.id) filter (where g.revoked_at is null) as active_session_count
         from relay_access_grants g
         left join relay_access_sessions s on s.grant_id = g.id
        where g.relay_room_id = $1
        group by g.id, g.relay_room_id, g.role, g.expires_at, g.revoked_at, g.created_at
        order by g.created_at desc`,
      [relayRoomId],
    );
    return result.rows.map(grantSummaryFromRow);
  }

  async verifyAccess(input: {
    relayRoomId?: string | null;
    token: string | undefined;
    operation: 'read' | 'write';
  }): Promise<VerifiedRelayAccess> {
    if (!input.token) throw new Error('forbidden');
    const tokenHash = hashRelayToken(input.token);
    const result = await this.pool.query<RelayGrantRow & RelayRoomRow>(
      `select g.id,
              g.relay_room_id,
              g.role,
              g.expires_at,
              g.revoked_at,
              g.created_at,
              r.host_session_id,
              r.state,
              r.last_ephemeral_yjs_state,
              r.last_shared_hash,
              r.shared_revision,
              r.created_at as room_created_at,
              r.updated_at
         from relay_access_grants g
         join relay_rooms r on r.id = g.relay_room_id
        where g.token_hash = $1
          and ($2::uuid is null or g.relay_room_id = $2)`,
      [tokenHash, input.relayRoomId ?? null],
    );
    const row = result.rows.find(isUsable);
    if (!row) throw new Error('forbidden');
    if (input.operation === 'write') assertRoleCanWrite(row.role);
    return {
      grantId: row.id,
      relayRoomId: row.relay_room_id,
      role: row.role,
      canRead: true,
      canWrite: row.role === 'edit',
      canView: true,
      canEdit: row.role === 'edit',
      hostOnline: isHostOnline(row.state),
      hostSessionId: row.host_session_id,
      sharedRevision: Number(row.shared_revision),
      lastSharedHash: row.last_shared_hash,
      lastEphemeralYjsState: optionalBytes(row.last_ephemeral_yjs_state),
      cacheUpdatedAt: toIsoString(row.updated_at) ?? new Date().toISOString(),
      ephemeralCacheExpiresAt: cacheExpiry(row.updated_at),
      stale: isEphemeralCacheStale(row.state, row.updated_at),
    };
  }

  async createOrUpdateSession(input: {
    grantId: string;
    relayRoomId: string;
    clientId: string;
    clientKind: RelayClientKind;
    displayName: string;
  }): Promise<RelayAccessSessionIdentity> {
    return withTransaction(this.pool, async (client) => {
      const grantResult = await client.query<RelayGrantRow>(
        `select id, relay_room_id, role, expires_at, revoked_at, created_at
           from relay_access_grants
          where id = $1
            and relay_room_id = $2
          for update`,
        [input.grantId, input.relayRoomId],
      );
      const grant = grantResult.rows[0];
      if (!grant || !isUsable(grant)) throw new Error('forbidden');

      const normalizedName = input.displayName.trim();
      const existing = await client.query<RelaySessionRow>(
        `update relay_access_sessions
            set display_name = case when $4 <> '' then $4 else display_name end,
                client_kind = $3,
                last_seen_at = now()
          where grant_id = $1
            and client_id = $2
          returning id, grant_id, client_id, client_kind, display_name, color, created_at, last_seen_at`,
        [input.grantId, input.clientId, input.clientKind, normalizedName],
      );
      const existingRow = existing.rows[0];
      if (existingRow) return sessionFromRow({ ...existingRow, role: grant.role });

      const displayName = normalizedName || (input.clientKind === 'daemon' ? 'Local mirror' : 'Guest');
      const color = colorForSession(input.grantId, input.clientId);
      const inserted = await client.query<RelaySessionRow>(
        `insert into relay_access_sessions
           (grant_id, client_id, client_kind, display_name, color)
         values ($1, $2, $3, $4, $5)
         returning id, grant_id, client_id, client_kind, display_name, color, created_at, last_seen_at`,
        [input.grantId, input.clientId, input.clientKind, displayName, color],
      );
      const insertedRow = inserted.rows[0];
      if (!insertedRow) throw new Error('relay_access_session_insert_failed');
      return sessionFromRow({ ...insertedRow, role: grant.role });
    });
  }

  async touchSession(sessionId: string): Promise<void> {
    await this.pool.query(
      `update relay_access_sessions
          set last_seen_at = now()
        where id = $1`,
      [sessionId],
    );
  }

  async listShareState(relayRoomId: string, localPath: string | null = null): Promise<RelayShareState> {
    const room = await this.getRoom(relayRoomId);
    const [links, sessionsResult] = await Promise.all([
      this.listAccessGrants(relayRoomId),
      this.pool.query<RelaySessionRow>(
        `select s.id,
                s.grant_id,
                g.relay_room_id,
                s.client_id,
                s.client_kind,
                s.display_name,
                s.color,
                g.role,
                s.created_at,
                s.last_seen_at
           from relay_access_sessions s
           join relay_access_grants g on g.id = s.grant_id
          where g.relay_room_id = $1
            and g.revoked_at is null
          order by s.last_seen_at desc`,
        [relayRoomId],
      ),
    ]);

    const hostSession = room.hostSessionId
      ? [
          {
            sessionId: room.hostSessionId,
            grantId: null,
            clientKind: 'daemon' as const,
            displayName: 'Host daemon',
            role: 'host' as const,
            lastSeenAt: room.updatedAt,
          },
        ]
      : [];

    return {
      localPath,
      relayRoomId,
      hostOnline: isHostOnline(room.state),
      hostSessionId: room.hostSessionId,
      sharedRevision: room.sharedRevision,
      lastSharedHash: room.lastSharedHash,
      links,
      sessions: [...hostSession, ...sessionsResult.rows.map(shareSessionFromRow)],
    };
  }

  async revokeAccessGrant(grantId: string): Promise<{ grantId: string; relayRoomId: string }> {
    const result = await this.pool.query<{ id: string; relay_room_id: string }>(
      `update relay_access_grants
          set revoked_at = now()
        where id = $1
          and revoked_at is null
        returning id, relay_room_id`,
      [grantId],
    );
    const row = result.rows[0];
    if (!row) throw new Error('relay_access_grant_not_found');
    return { grantId: row.id, relayRoomId: row.relay_room_id };
  }

  async assertTokenHashNotStoredAsRawToken(token: string, tokenHash: string): Promise<void> {
    if (hashesMatch(token, tokenHash)) throw new Error('relay_token_hash_matches_raw_token');
  }

  async cleanupExpiredRelayState(input: {
    now?: Date;
    staleSessionTtlMs?: number;
  } = {}): Promise<RelayCleanupResult> {
    const now = input.now ?? new Date();
    const staleSessionTtlMs = Number.isFinite(input.staleSessionTtlMs) && input.staleSessionTtlMs! > 0
      ? input.staleSessionTtlMs!
      : 24 * 60 * 60 * 1000;
    const staleBefore = new Date(now.getTime() - staleSessionTtlMs);

    const expiredGrants = await this.pool.query(
      `update relay_access_grants
          set revoked_at = coalesce(revoked_at, $1),
              cleanup_last_run_at = $1
        where expires_at is not null
          and expires_at <= $1
          and revoked_at is null`,
      [now],
    );
    const staleSessions = await this.pool.query(
      `delete from relay_access_sessions
        where (expires_at is not null and expires_at <= $1)
           or last_seen_at < $2
           or exists (
              select 1
                from relay_access_grants g
               where g.id = relay_access_sessions.grant_id
                 and (g.revoked_at is not null or (g.expires_at is not null and g.expires_at <= $1))
           )`,
      [now, staleBefore],
    );
    const expiredEphemeralRooms = await this.pool.query(
      `update relay_rooms
          set last_ephemeral_yjs_state = null,
              ephemeral_cache_expires_at = null,
              cleanup_last_run_at = $1,
              updated_at = now()
        where ephemeral_cache_expires_at is not null
          and ephemeral_cache_expires_at <= $1`,
      [now],
    );

    return {
      expiredGrants: expiredGrants.rowCount ?? 0,
      staleSessions: staleSessions.rowCount ?? 0,
      expiredEphemeralRooms: expiredEphemeralRooms.rowCount ?? 0,
    };
  }
}

export function createRelayRoomService(pool: DbPool): RelayRoomService {
  return new RelayRoomService(pool);
}

export function createInMemoryRelayRoomService(): RelayRoomService {
  let nextRoomId = 1;
  let nextGrantId = 1;
  let nextSessionId = 1;
  const rooms = new Map<string, RelayRoom>();
  const hostTokenHashes = new Map<string, string>();
  const grants = new Map<
    string,
    RelayAccessGrantSummary & { tokenHash: string; expiresAtRaw: string | null }
  >();
  const sessions = new Map<string, RelayAccessSessionIdentity>();

  const dummyPool: DbPool = {
    query: async () => ({ rows: [], rowCount: 0 }),
    connect: async () => ({
      query: async () => ({ rows: [], rowCount: 0 }),
      release: () => undefined,
    }),
  };

  function now(): string {
    return new Date().toISOString();
  }

  class InMemoryRelayRoomService extends RelayRoomService {
    constructor() {
      super(dummyPool);
    }

    override async createRoom(input: {
      hostSessionId?: string | null;
      hostAuthToken?: string | null;
      lastEphemeralYjsState?: Uint8Array | null;
      lastSharedHash?: string | null;
    } = {}): Promise<RelayRoom> {
      const timestamp = now();
      const lastSharedHash = input.lastEphemeralYjsState
        ? await hashRelayYjsMarkdownState(input.lastEphemeralYjsState)
        : (input.lastSharedHash ?? null);
      const room: RelayRoom = {
        relayRoomId: `relay_${nextRoomId++}`,
        hostSessionId: input.hostSessionId ?? null,
        state: input.hostSessionId ? 'host_online' : 'host_offline',
        lastEphemeralYjsState: input.lastEphemeralYjsState ? new Uint8Array(input.lastEphemeralYjsState) : null,
        lastSharedHash,
        sharedRevision: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      rooms.set(room.relayRoomId, room);
      if (input.hostAuthToken) hostTokenHashes.set(room.relayRoomId, hashRelayToken(input.hostAuthToken));
      return room;
    }

    override async verifyHost(relayRoomId: string, hostToken: string | undefined): Promise<void> {
      if (!hostToken) throw new Error('forbidden');
      const expected = hostTokenHashes.get(relayRoomId);
      if (!expected || !hashesMatch(hashRelayToken(hostToken), expected)) throw new Error('forbidden');
    }

    override async getRoom(relayRoomId: string): Promise<RelayRoom> {
      const room = rooms.get(relayRoomId);
      if (!room) throw new Error('relay_room_not_found');
      return { ...room, lastEphemeralYjsState: room.lastEphemeralYjsState ? new Uint8Array(room.lastEphemeralYjsState) : null };
    }

    override async markHostOnline(relayRoomId: string, hostSessionId: string): Promise<RelayRoom> {
      const room = await this.getRoom(relayRoomId);
      const next = { ...room, hostSessionId, state: 'host_online' as const, updatedAt: now() };
      rooms.set(relayRoomId, next);
      return next;
    }

    override async markHostOffline(relayRoomId: string, hostSessionId?: string | null): Promise<RelayRoom | null> {
      const room = rooms.get(relayRoomId);
      if (!room || (hostSessionId && room.hostSessionId !== hostSessionId)) return null;
      const next = { ...room, state: 'host_offline' as const, updatedAt: now() };
      rooms.set(relayRoomId, next);
      return next;
    }

    override async acceptSharedState(input: {
      relayRoomId: string;
      yjsState: Uint8Array;
      sharedHash: string;
      expectedRevision?: number | null;
      expectedSharedHash?: string | null;
    }): Promise<RelayRoom> {
      const sharedHash = await hashRelayYjsMarkdownState(input.yjsState);
      const room = await this.getRoom(input.relayRoomId);
      if (!isHostOnline(room.state)) throw new Error('relay_shared_state_not_accepted');
      if (input.expectedRevision !== undefined && input.expectedRevision !== null && input.expectedRevision !== room.sharedRevision) {
        throw new Error('relay_shared_state_not_accepted');
      }
      if (input.expectedSharedHash !== undefined && input.expectedSharedHash !== null && input.expectedSharedHash !== (room.lastSharedHash ?? '')) {
        throw new Error('relay_shared_state_not_accepted');
      }
      const next = {
        ...room,
        lastEphemeralYjsState: new Uint8Array(input.yjsState),
        lastSharedHash: sharedHash,
        sharedRevision: room.sharedRevision + 1,
        updatedAt: now(),
      };
      rooms.set(input.relayRoomId, next);
      return next;
    }

    override async createAccessGrant(input: {
      relayRoomId: string;
      role: RelayAccessRole;
      expiresAt?: string | null;
    }): Promise<CreatedRelayAccessGrant> {
      await this.getRoom(input.relayRoomId);
      const token = generateRelayToken();
      const grantId = `grant_${nextGrantId++}`;
      const createdAt = now();
      grants.set(grantId, {
        grantId,
        relayRoomId: input.relayRoomId,
        role: input.role,
        label: null,
        canCopyExistingUrl: false,
        revokedAt: null,
        expiresAt: input.expiresAt ?? null,
        expiresAtRaw: input.expiresAt ?? null,
        createdAt,
        activeSessionCount: 0,
        lastCopiedAt: null,
        tokenHash: hashRelayToken(token),
      });
      return { grantId, relayRoomId: input.relayRoomId, token, role: input.role, expiresAt: input.expiresAt ?? null, createdAt };
    }

    override async listAccessGrants(relayRoomId: string): Promise<RelayAccessGrantSummary[]> {
      return [...grants.values()]
        .filter((grant) => grant.relayRoomId === relayRoomId)
        .map(({ tokenHash: _tokenHash, expiresAtRaw: _expiresAtRaw, ...grant }) => ({
          ...grant,
          activeSessionCount: [...sessions.values()].filter((session) => session.grantId === grant.grantId).length,
        }));
    }

    override async verifyAccess(input: {
      relayRoomId?: string | null;
      token: string | undefined;
      operation: 'read' | 'write';
    }): Promise<VerifiedRelayAccess> {
      if (!input.token) throw new Error('forbidden');
      const tokenHash = hashRelayToken(input.token);
      const grant = [...grants.values()].find(
        (candidate) =>
          candidate.tokenHash === tokenHash &&
          (!input.relayRoomId || candidate.relayRoomId === input.relayRoomId) &&
          !candidate.revokedAt &&
          !isExpired(candidate.expiresAtRaw),
      );
      if (!grant) throw new Error('forbidden');
      if (input.operation === 'write') assertRoleCanWrite(grant.role);
      const room = await this.getRoom(grant.relayRoomId);
      return {
        grantId: grant.grantId,
        relayRoomId: grant.relayRoomId,
        role: grant.role,
        canRead: true,
        canWrite: grant.role === 'edit',
        canView: true,
        canEdit: grant.role === 'edit',
        hostOnline: isHostOnline(room.state),
        hostSessionId: room.hostSessionId,
        sharedRevision: room.sharedRevision,
        lastSharedHash: room.lastSharedHash,
        lastEphemeralYjsState: room.lastEphemeralYjsState,
        cacheUpdatedAt: room.updatedAt,
        ephemeralCacheExpiresAt: cacheExpiry(room.updatedAt),
        stale: isEphemeralCacheStale(room.state, room.updatedAt),
      };
    }

    override async createOrUpdateSession(input: {
      grantId: string;
      relayRoomId: string;
      clientId: string;
      clientKind: RelayClientKind;
      displayName: string;
    }): Promise<RelayAccessSessionIdentity> {
      const grant = grants.get(input.grantId);
      if (!grant || grant.relayRoomId !== input.relayRoomId || grant.revokedAt || isExpired(grant.expiresAtRaw)) {
        throw new Error('forbidden');
      }
      const existing = [...sessions.values()].find(
        (session) => session.grantId === input.grantId && session.clientId === input.clientId,
      );
      if (existing) {
        const next = {
          ...existing,
          clientKind: input.clientKind,
          displayName: input.displayName.trim() || existing.displayName,
          lastSeenAt: now(),
        };
        sessions.set(existing.sessionId, next);
        return next;
      }
      const timestamp = now();
      const session: RelayAccessSessionIdentity = {
        grantId: input.grantId,
        relayRoomId: input.relayRoomId,
        sessionId: `session_${nextSessionId++}`,
        clientId: input.clientId,
        clientKind: input.clientKind,
        displayName: input.displayName.trim() || (input.clientKind === 'daemon' ? 'Local mirror' : 'Guest'),
        color: colorForSession(input.grantId, input.clientId),
        role: grant.role,
        createdAt: timestamp,
        lastSeenAt: timestamp,
      };
      sessions.set(session.sessionId, session);
      return session;
    }

    override async touchSession(sessionId: string): Promise<void> {
      const session = sessions.get(sessionId);
      if (session) sessions.set(sessionId, { ...session, lastSeenAt: now() });
    }

    override async listShareState(relayRoomId: string, localPath: string | null = null): Promise<RelayShareState> {
      const room = await this.getRoom(relayRoomId);
      const hostSession = room.hostSessionId
        ? [
            {
              sessionId: room.hostSessionId,
              grantId: null,
              clientKind: 'daemon' as const,
              displayName: 'Host daemon',
              role: 'host' as const,
              lastSeenAt: room.updatedAt,
            },
          ]
        : [];
      return {
        localPath,
        relayRoomId,
        hostOnline: isHostOnline(room.state),
        hostSessionId: room.hostSessionId,
        sharedRevision: room.sharedRevision,
        lastSharedHash: room.lastSharedHash,
        links: await this.listAccessGrants(relayRoomId),
        sessions: [
          ...hostSession,
          ...[...sessions.values()]
            .filter((session) => grants.get(session.grantId ?? '')?.relayRoomId === relayRoomId)
            .map((session) => ({
              sessionId: session.sessionId,
              grantId: session.grantId,
              clientKind: session.clientKind,
              displayName: session.displayName,
              role: session.role,
              lastSeenAt: session.lastSeenAt,
            })),
        ],
      };
    }

    override async revokeAccessGrant(grantId: string): Promise<{ grantId: string; relayRoomId: string }> {
      const grant = grants.get(grantId);
      if (!grant || grant.revokedAt) throw new Error('relay_access_grant_not_found');
      grants.set(grantId, { ...grant, revokedAt: now() });
      return { grantId, relayRoomId: grant.relayRoomId };
    }

    override async cleanupExpiredRelayState(input: {
      now?: Date;
      staleSessionTtlMs?: number;
    } = {}): Promise<RelayCleanupResult> {
      const nowMs = (input.now ?? new Date()).getTime();
      const staleSessionTtlMs = Number.isFinite(input.staleSessionTtlMs) && input.staleSessionTtlMs! > 0
        ? input.staleSessionTtlMs!
        : 24 * 60 * 60 * 1000;
      let expiredGrants = 0;
      let staleSessions = 0;
      let expiredEphemeralRooms = 0;

      for (const [grantId, grant] of grants) {
        if (!grant.revokedAt && isExpired(grant.expiresAtRaw, nowMs)) {
          grants.set(grantId, { ...grant, revokedAt: new Date(nowMs).toISOString() });
          expiredGrants += 1;
        }
      }

      for (const [sessionId, session] of [...sessions]) {
        const grant = session.grantId ? grants.get(session.grantId) : null;
        const lastSeenAt = new Date(session.lastSeenAt).getTime();
        if ((grant && (grant.revokedAt || isExpired(grant.expiresAtRaw, nowMs))) || nowMs - lastSeenAt > staleSessionTtlMs) {
          sessions.delete(sessionId);
          staleSessions += 1;
        }
      }

      for (const [relayRoomId, room] of rooms) {
        if (!isEphemeralCacheStale(room.state, room.updatedAt) || !room.lastEphemeralYjsState) continue;
        rooms.set(relayRoomId, { ...room, lastEphemeralYjsState: null, updatedAt: new Date(nowMs).toISOString() });
        expiredEphemeralRooms += 1;
      }

      return { expiredGrants, staleSessions, expiredEphemeralRooms };
    }
  }

  return new InMemoryRelayRoomService();
}

export interface RelayRoomStatus {
  relayRoomId: string;
  hostOnline: boolean;
  hostSessionId: string | null;
  state: RelayRoomState;
  sharedRevision: number;
  lastSharedHash: string | null;
  lastEphemeralYjsState: Uint8Array | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRelayRoomInput {
  state?: RelayHostState;
  sharedRevision?: number;
  lastSharedHash?: string | null;
  lastEphemeralYjsState?: Uint8Array | null;
}

export interface CreateRelayGrantInput {
  relayRoomId: string;
  role: RelayAccessRole;
  expiresAt?: string | null;
}

export interface CreateOrUpdateRelaySessionInput {
  relayRoomId: string;
  grantId?: string | null;
  role?: 'host';
  clientId: string;
  clientKind: RelayClientKind;
  displayName: string;
}

export interface UpdateRelaySharedStateInput {
  relayRoomId: string;
  sharedRevision: number;
  lastSharedHash: string | null;
  lastEphemeralYjsState?: Uint8Array | null;
}

export interface RelayShareStateInput {
  localPath?: string | null;
  relayRoomId: string | null;
}

function relayRoomStatusFromRow(row: RelayRoomRow): RelayRoomStatus {
  const room = relayRoomFromRow(row);
  return {
    relayRoomId: room.relayRoomId,
    hostOnline: isHostOnline(room.state),
    hostSessionId: room.hostSessionId,
    state: room.state,
    sharedRevision: room.sharedRevision,
    lastSharedHash: room.lastSharedHash,
    lastEphemeralYjsState: room.lastEphemeralYjsState,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
  };
}

function nextGuestName(rows: Array<{ display_name: string }>): string {
  let maxGuestNumber = 0;
  for (const row of rows) {
    const match = /^Guest\s+(\d+)$/u.exec(row.display_name);
    if (!match?.[1]) continue;
    maxGuestNumber = Math.max(maxGuestNumber, Number(match[1]));
  }
  return `Guest ${maxGuestNumber + 1}`;
}

export async function createRelayRoom(pool: DbPool, input: CreateRelayRoomInput = {}): Promise<RelayRoomStatus> {
  const result = await pool.query<RelayRoomRow>(
    `insert into relay_rooms
       (state, last_ephemeral_yjs_state, last_shared_hash, shared_revision)
     values ($1, $2, $3, $4)
     returning id, host_session_id, state, last_ephemeral_yjs_state, last_shared_hash, shared_revision, created_at, updated_at`,
    [
      input.state ?? 'host_offline',
      input.lastEphemeralYjsState ? Buffer.from(input.lastEphemeralYjsState) : null,
      input.lastSharedHash ?? null,
      input.sharedRevision ?? 0,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('relay_room_insert_failed');
  return relayRoomStatusFromRow(row);
}

export async function createRelayGrant(pool: DbPool, input: CreateRelayGrantInput): Promise<CreatedRelayAccessGrant> {
  return new RelayRoomService(pool).createAccessGrant(input);
}

export async function listRelayGrants(pool: DbPool, relayRoomId: string): Promise<RelayAccessGrantSummary[]> {
  return new RelayRoomService(pool).listAccessGrants(relayRoomId);
}

export async function revokeRelayGrant(
  pool: DbPool,
  grantId: string,
): Promise<{ grantId: string; relayRoomId: string; revoked: true }> {
  const result = await pool.query<{ id: string; relay_room_id: string }>(
    `update relay_access_grants
        set revoked_at = now()
      where id = $1
        and revoked_at is null
      returning id, relay_room_id`,
    [grantId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('relay_access_grant_not_found');
  return { grantId: row.id, relayRoomId: row.relay_room_id, revoked: true };
}

export async function verifyRelayAccess(
  pool: DbPool,
  token: string | undefined,
  operation: 'view' | 'edit',
): Promise<VerifiedRelayAccess> {
  if (!token) throw new Error('forbidden');
  const grantResult = await pool.query<RelayGrantRow>(
    `select id, relay_room_id, role, expires_at, revoked_at, created_at
       from relay_access_grants
      where token_hash = $1`,
    [hashRelayToken(token)],
  );
  const grant = grantResult.rows.find(isUsable);
  if (!grant) throw new Error('forbidden');
  if (operation === 'edit') assertRoleCanWrite(grant.role);

  const roomResult = await pool.query<RelayRoomRow>(
    `select id, host_session_id, state, last_ephemeral_yjs_state, last_shared_hash, shared_revision, created_at, updated_at
       from relay_rooms
      where id = $1`,
    [grant.relay_room_id],
  );
  const room = roomResult.rows[0];
  if (!room) throw new Error('relay_room_not_found');

  return {
    grantId: grant.id,
    relayRoomId: grant.relay_room_id,
    role: grant.role,
    canRead: true,
    canWrite: grant.role === 'edit',
    canView: true,
    canEdit: grant.role === 'edit',
    hostOnline: isHostOnline(room.state),
    hostSessionId: room.host_session_id,
    sharedRevision: Number(room.shared_revision),
    lastSharedHash: room.last_shared_hash,
    lastEphemeralYjsState: optionalBytes(room.last_ephemeral_yjs_state),
    cacheUpdatedAt: toIsoString(room.updated_at) ?? new Date().toISOString(),
    ephemeralCacheExpiresAt: cacheExpiry(room.updated_at),
    stale: isEphemeralCacheStale(room.state, room.updated_at),
  };
}

export async function createOrUpdateRelaySession(
  pool: DbPool,
  input: CreateOrUpdateRelaySessionInput,
): Promise<RelayAccessSessionIdentity> {
  return withTransaction(pool, async (client) => {
    const normalizedName = input.displayName.trim();

    if (input.role === 'host' || !input.grantId) {
      const roomResult = await client.query<RelayRoomRow>(
        `select id, host_session_id, state, last_ephemeral_yjs_state, last_shared_hash, shared_revision, created_at, updated_at
           from relay_rooms
          where id = $1
          for update`,
        [input.relayRoomId],
      );
      const room = roomResult.rows[0];
      if (!room) throw new Error('relay_room_not_found');

      const existing = room.host_session_id
        ? await client.query<RelaySessionRow>(
            `update relay_access_sessions
                set client_id = $2,
                    client_kind = $3,
                    display_name = case when $4 <> '' then $4 else display_name end,
                    last_seen_at = now()
              where id = $1
              returning id, grant_id, client_id, client_kind, display_name, color, created_at, last_seen_at`,
            [room.host_session_id, input.clientId, input.clientKind, normalizedName],
          )
        : { rows: [], rowCount: 0 };
      const existingRow = existing.rows[0];
      if (existingRow) {
        return {
          ...sessionFromRow({ ...existingRow, role: 'host' }),
          relayRoomId: input.relayRoomId,
          grantId: null,
          role: 'host',
        };
      }

      const displayName = normalizedName || 'Host daemon';
      const color = colorForSession(`host:${input.relayRoomId}`, input.clientId);
      const inserted = await client.query<RelaySessionRow>(
        `insert into relay_access_sessions
           (grant_id, client_id, client_kind, display_name, color)
         values ($1, $2, $3, $4, $5)
         returning id, grant_id, client_id, client_kind, display_name, color, created_at, last_seen_at`,
        [null, input.clientId, input.clientKind, displayName, color],
      );
      const insertedRow = inserted.rows[0];
      if (!insertedRow) throw new Error('relay_access_session_insert_failed');
      await client.query<RelayRoomRow>(
        `update relay_rooms
            set host_session_id = $2,
                state = 'host_online',
                updated_at = now()
          where id = $1
          returning id, host_session_id, state, last_ephemeral_yjs_state, last_shared_hash, shared_revision, created_at, updated_at`,
        [input.relayRoomId, insertedRow.id],
      );
      return {
        ...sessionFromRow({ ...insertedRow, grant_id: null, role: 'host' }),
        relayRoomId: input.relayRoomId,
        grantId: null,
        role: 'host',
      };
    }

    const grantResult = await client.query<RelayGrantRow>(
      `select id, relay_room_id, role, expires_at, revoked_at, created_at
         from relay_access_grants
        where id = $1
          and relay_room_id = $2
        for update`,
      [input.grantId, input.relayRoomId],
    );
    const grant = grantResult.rows[0];
    if (!grant || !isUsable(grant)) throw new Error('forbidden');

    const existing = await client.query<RelaySessionRow>(
      `update relay_access_sessions
          set client_kind = $3,
              display_name = case when $4 <> '' then $4 else display_name end,
              last_seen_at = now()
        where grant_id = $1
          and client_id = $2
        returning id, grant_id, client_id, client_kind, display_name, color, created_at, last_seen_at`,
      [input.grantId, input.clientId, input.clientKind, normalizedName],
    );
    const existingRow = existing.rows[0];
    if (existingRow) return { ...sessionFromRow({ ...existingRow, role: grant.role }), relayRoomId: input.relayRoomId };

    let displayName = normalizedName;
    if (!displayName) {
      const guests = await client.query<{ display_name: string }>(
        `select display_name
           from relay_access_sessions
          where grant_id = $1
            and display_name like 'Guest %'
          for update`,
        [input.grantId],
      );
      displayName = nextGuestName(guests.rows);
    }

    const color = colorForSession(input.grantId, input.clientId);
    const inserted = await client.query<RelaySessionRow>(
      `insert into relay_access_sessions
         (grant_id, client_id, client_kind, display_name, color)
       values ($1, $2, $3, $4, $5)
       returning id, grant_id, client_id, client_kind, display_name, color, created_at, last_seen_at`,
      [input.grantId, input.clientId, input.clientKind, displayName, color],
    );
    const insertedRow = inserted.rows[0];
    if (!insertedRow) throw new Error('relay_access_session_insert_failed');
    return { ...sessionFromRow({ ...insertedRow, role: grant.role }), relayRoomId: input.relayRoomId };
  });
}

export async function updateRelaySharedState(pool: DbPool, input: UpdateRelaySharedStateInput): Promise<RelayRoomStatus> {
  const result = await pool.query<RelayRoomRow>(
    `update relay_rooms
        set shared_revision = $2,
            last_shared_hash = $3,
            last_ephemeral_yjs_state = $4,
            updated_at = now()
      where id = $1
      returning id, host_session_id, state, last_ephemeral_yjs_state, last_shared_hash, shared_revision, created_at, updated_at`,
    [
      input.relayRoomId,
      input.sharedRevision,
      input.lastSharedHash,
      input.lastEphemeralYjsState ? Buffer.from(input.lastEphemeralYjsState) : null,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('relay_room_not_found');
  return relayRoomStatusFromRow(row);
}

export async function setRelayHostOffline(pool: DbPool, relayRoomId: string): Promise<RelayRoomStatus> {
  const result = await pool.query<RelayRoomRow>(
    `update relay_rooms
        set state = 'host_offline',
            updated_at = now()
      where id = $1
      returning id, host_session_id, state, last_ephemeral_yjs_state, last_shared_hash, shared_revision, created_at, updated_at`,
    [relayRoomId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('relay_room_not_found');
  return relayRoomStatusFromRow(row);
}

export async function getRelayShareState(pool: DbPool, input: RelayShareStateInput): Promise<RelayShareState> {
  if (!input.relayRoomId) {
    return {
      localPath: input.localPath ?? null,
      relayRoomId: null,
      hostOnline: false,
      hostSessionId: null,
      sharedRevision: null,
      lastSharedHash: null,
      links: [],
      sessions: [],
    };
  }

  const roomResult = await pool.query<RelayRoomRow>(
    `select id, host_session_id, state, last_ephemeral_yjs_state, last_shared_hash, shared_revision, created_at, updated_at
       from relay_rooms
      where id = $1`,
    [input.relayRoomId],
  );
  const room = roomResult.rows[0];
  if (!room) throw new Error('relay_room_not_found');

  const [links, sessionsResult] = await Promise.all([
    listRelayGrants(pool, input.relayRoomId),
    pool.query<RelaySessionRow>(
      `select s.id,
              s.grant_id,
              s.client_id,
              s.client_kind,
              s.display_name,
              s.color,
              'host' as role,
              s.created_at,
              s.last_seen_at
         from relay_rooms r
         join relay_access_sessions s on s.id = r.host_session_id
        where r.id = $1
       union all
       select s.id,
              s.grant_id,
              s.client_id,
              s.client_kind,
              s.display_name,
              s.color,
              g.role,
              s.created_at,
              s.last_seen_at
         from relay_access_sessions s
         join relay_access_grants g on g.id = s.grant_id
        where g.relay_room_id = $1
          and g.revoked_at is null
        order by last_seen_at desc`,
      [input.relayRoomId],
    ),
  ]);

  return {
    localPath: input.localPath ?? null,
    relayRoomId: room.id,
    hostOnline: isHostOnline(room.state),
    hostSessionId: room.host_session_id,
    sharedRevision: Number(room.shared_revision),
    lastSharedHash: room.last_shared_hash,
    links,
    sessions: sessionsResult.rows.map(shareSessionFromRow),
  };
}

export async function cleanupExpiredRelayState(
  pool: DbPool,
  input: { now?: Date; staleSessionTtlMs?: number } = {},
): Promise<RelayCleanupResult> {
  return new RelayRoomService(pool).cleanupExpiredRelayState(input);
}
