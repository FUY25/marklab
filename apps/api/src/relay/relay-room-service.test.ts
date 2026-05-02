import { describe, expect, it } from 'vitest';
import type { DbPool, DbQueryResult, DbTransactionClient } from '../db/client';
import {
  createOrUpdateRelaySession,
  createRelayGrant,
  createRelayRoom,
  cleanupExpiredRelayState,
  getRelayShareState,
  hashRelayToken,
  revokeRelayGrant,
  setRelayHostOffline,
  updateRelaySharedState,
  verifyRelayAccess,
  type RelayClientKind,
  type RelayGrantRole,
  type RelayHostState,
} from './relay-room-service';

interface CapturedQuery {
  sql: string;
  params?: readonly unknown[];
}

interface RelayRoomRecord {
  id: string;
  host_session_id: string | null;
  state: RelayHostState;
  last_ephemeral_yjs_state: Uint8Array | null;
  last_shared_hash: string | null;
  shared_revision: number;
  created_at: Date | string;
  updated_at: Date | string;
}

interface RelayGrantRecord {
  id: string;
  relay_room_id: string;
  token_hash: string;
  role: RelayGrantRole;
  expires_at: Date | string | null;
  revoked_at: Date | string | null;
  created_at: Date | string;
}

interface RelaySessionRecord {
  id: string;
  grant_id: string | null;
  client_id: string;
  client_kind: RelayClientKind;
  display_name: string;
  color: string;
  created_at: Date | string;
  last_seen_at: Date | string;
}

const createdAt = new Date('2026-05-01T12:00:00Z');
const updatedAt = new Date('2026-05-01T12:05:00Z');

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function createRelayPool(seed: {
  rooms?: RelayRoomRecord[];
  grants?: RelayGrantRecord[];
  sessions?: RelaySessionRecord[];
} = {}) {
  const queries: CapturedQuery[] = [];
  const rooms = seed.rooms ?? [];
  const grants = seed.grants ?? [];
  const sessions = seed.sessions ?? [];
  let nextRoomId = rooms.length + 1;
  let nextGrantId = grants.length + 1;
  let nextSessionId = sessions.length + 1;

  const query: DbPool['query'] = async <Row = unknown>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<DbQueryResult<Row>> => {
    queries.push(params === undefined ? { sql } : { sql, params });

    if (sql.includes('insert into relay_rooms')) {
      const room: RelayRoomRecord = {
        id: `room_${nextRoomId++}`,
        host_session_id: null,
        state: params?.[0] as RelayHostState,
        last_ephemeral_yjs_state: (params?.[1] as Uint8Array | null | undefined) ?? null,
        last_shared_hash: (params?.[2] as string | null | undefined) ?? null,
        shared_revision: Number(params?.[3] ?? 0),
        created_at: createdAt,
        updated_at: createdAt,
      };
      rooms.push(room);
      return { rows: [room as Row], rowCount: 1 };
    }

    if (sql.includes('update relay_rooms') && sql.includes('host_session_id = $2')) {
      const room = rooms.find((candidate) => candidate.id === params?.[0]);
      if (!room) return { rows: [], rowCount: 0 };
      room.host_session_id = String(params?.[1]);
      room.state = 'host_online';
      room.updated_at = updatedAt;
      return { rows: [room as Row], rowCount: 1 };
    }

    if (sql.includes('update relay_rooms') && sql.includes("state = 'host_offline'")) {
      const room = rooms.find((candidate) => candidate.id === params?.[0]);
      if (!room) return { rows: [], rowCount: 0 };
      room.state = 'host_offline';
      room.updated_at = updatedAt;
      return { rows: [room as Row], rowCount: 1 };
    }

    if (sql.includes('update relay_rooms') && sql.includes('shared_revision = $2')) {
      const room = rooms.find((candidate) => candidate.id === params?.[0]);
      if (!room) return { rows: [], rowCount: 0 };
      room.shared_revision = Number(params?.[1]);
      room.last_shared_hash = (params?.[2] as string | null | undefined) ?? null;
      room.last_ephemeral_yjs_state = (params?.[3] as Uint8Array | null | undefined) ?? null;
      room.updated_at = updatedAt;
      return { rows: [room as Row], rowCount: 1 };
    }

    if (sql.includes('from relay_rooms') && sql.includes('for update')) {
      const room = rooms.find((candidate) => candidate.id === params?.[0]);
      return { rows: (room ? [room] : []) as Row[], rowCount: room ? 1 : 0 };
    }

    if (sql.includes('from relay_rooms') && sql.includes('where id = $1')) {
      const room = rooms.find((candidate) => candidate.id === params?.[0]);
      return { rows: (room ? [room] : []) as Row[], rowCount: room ? 1 : 0 };
    }

    if (sql.includes('insert into relay_access_grants')) {
      const grant: RelayGrantRecord = {
        id: `grant_${nextGrantId++}`,
        relay_room_id: String(params?.[0]),
        token_hash: String(params?.[1]),
        role: params?.[2] as RelayGrantRole,
        expires_at: (params?.[3] as Date | string | null | undefined) ?? null,
        revoked_at: null,
        created_at: createdAt,
      };
      grants.push(grant);
      return { rows: [grant as Row], rowCount: 1 };
    }

    if (sql.includes('from relay_access_grants') && sql.includes('token_hash = $1')) {
      const grant = grants.find((candidate) => candidate.token_hash === params?.[0]);
      return { rows: (grant ? [grant] : []) as Row[], rowCount: grant ? 1 : 0 };
    }

    if (sql.includes('from relay_access_grants') && sql.includes('for update')) {
      const grant = grants.find((candidate) => candidate.id === params?.[0] && candidate.relay_room_id === params?.[1]);
      return { rows: (grant ? [grant] : []) as Row[], rowCount: grant ? 1 : 0 };
    }

    if (sql.includes('select g.id') && sql.includes('from relay_access_grants g')) {
      const rows = grants
        .filter((grant) => grant.relay_room_id === params?.[0])
        .map((grant) => ({
          ...grant,
          active_session_count: grant.revoked_at ? 0 : sessions.filter((session) => session.grant_id === grant.id).length,
        }));
      return { rows: rows as Row[], rowCount: rows.length };
    }

    if (sql.includes('update relay_access_grants') && sql.includes('cleanup_last_run_at')) {
      let rowCount = 0;
      for (const grant of grants) {
        if (!grant.expires_at || grant.revoked_at) continue;
        if (new Date(grant.expires_at).getTime() > new Date(params?.[0] as Date).getTime()) continue;
        grant.revoked_at = params?.[0] as Date;
        rowCount += 1;
      }
      return { rows: [], rowCount };
    }

    if (sql.includes('update relay_access_grants')) {
      const grant = grants.find((candidate) => candidate.id === params?.[0] && candidate.revoked_at === null);
      if (!grant) return { rows: [], rowCount: 0 };
      grant.revoked_at = updatedAt;
      return { rows: [{ id: grant.id, relay_room_id: grant.relay_room_id } as Row], rowCount: 1 };
    }

    if (sql.includes('delete from relay_access_sessions')) {
      const now = new Date(params?.[0] as Date).getTime();
      const staleBefore = new Date(params?.[1] as Date).getTime();
      let rowCount = 0;
      for (const session of [...sessions]) {
        const grant = grants.find((candidate) => candidate.id === session.grant_id);
        const grantExpired = Boolean(grant?.expires_at && new Date(grant.expires_at).getTime() <= now);
        const grantRevoked = Boolean(grant?.revoked_at);
        const stale = new Date(session.last_seen_at).getTime() < staleBefore;
        if (!grantExpired && !grantRevoked && !stale) continue;
        sessions.splice(sessions.indexOf(session), 1);
        rowCount += 1;
      }
      return { rows: [], rowCount };
    }

    if (sql.includes('update relay_rooms') && sql.includes('cleanup_last_run_at')) {
      let rowCount = 0;
      const now = new Date(params?.[0] as Date).getTime();
      for (const room of rooms as Array<RelayRoomRecord & { ephemeral_cache_expires_at?: Date | string | null }>) {
        if (!room.ephemeral_cache_expires_at || new Date(room.ephemeral_cache_expires_at).getTime() > now) continue;
        room.last_ephemeral_yjs_state = null;
        room.ephemeral_cache_expires_at = null;
        rowCount += 1;
      }
      return { rows: [], rowCount };
    }

    if (sql.includes('update relay_access_sessions') && sql.includes('where id = $1')) {
      const session = sessions.find((candidate) => candidate.id === params?.[0]);
      if (!session) return { rows: [], rowCount: 0 };
      const displayName = String(params?.[3] ?? '').trim();
      session.client_id = String(params?.[1]);
      session.client_kind = params?.[2] as RelayClientKind;
      if (displayName) session.display_name = displayName;
      session.last_seen_at = updatedAt;
      return { rows: [session as Row], rowCount: 1 };
    }

    if (sql.includes('update relay_access_sessions') && sql.includes('grant_id = $1')) {
      const session = sessions.find((candidate) => candidate.grant_id === params?.[0] && candidate.client_id === params?.[1]);
      if (!session) return { rows: [], rowCount: 0 };
      const displayName = String(params?.[3] ?? '').trim();
      session.client_kind = params?.[2] as RelayClientKind;
      if (displayName) session.display_name = displayName;
      session.last_seen_at = updatedAt;
      return { rows: [session as Row], rowCount: 1 };
    }

    if (sql.includes('from relay_access_sessions') && sql.includes('display_name like')) {
      const rows = sessions.filter((session) => session.grant_id === params?.[0] && session.display_name.startsWith('Guest '));
      return { rows: rows as Row[], rowCount: rows.length };
    }

    if (sql.includes('insert into relay_access_sessions')) {
      const session: RelaySessionRecord = {
        id: `session_${nextSessionId++}`,
        grant_id: (params?.[0] as string | null | undefined) ?? null,
        client_id: String(params?.[1]),
        client_kind: params?.[2] as RelayClientKind,
        display_name: String(params?.[3]),
        color: String(params?.[4]),
        created_at: createdAt,
        last_seen_at: createdAt,
      };
      sessions.push(session);
      return { rows: [session as Row], rowCount: 1 };
    }

    if (sql.includes('from relay_access_sessions s') && sql.includes("'host' as role")) {
      const room = rooms.find((candidate) => candidate.id === params?.[0]);
      const host = sessions.find((session) => session.id === room?.host_session_id);
      const collaboratorRows = sessions
        .filter((session) => {
          const grant = grants.find((candidate) => candidate.id === session.grant_id);
          return Boolean(grant && grant.relay_room_id === params?.[0] && grant.revoked_at === null);
        })
        .map((session) => ({
          ...session,
          role: grants.find((grant) => grant.id === session.grant_id)?.role,
        }));
      const rows = [
        ...(host ? [{ ...host, grant_id: null, role: 'host' }] : []),
        ...collaboratorRows,
      ];
      return { rows: rows as Row[], rowCount: rows.length };
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

  return { pool, queries, rooms, grants, sessions };
}

function expectNoCloudDocumentSql(queries: CapturedQuery[]) {
  const sql = queries.map((query) => query.sql).join('\n');
  expect(sql).not.toMatch(/\bdocuments\b/u);
  expect(sql).not.toMatch(/\bdocument_branches\b/u);
  expect(sql).not.toMatch(/\bdocument_branch_states\b/u);
  expect(sql).not.toMatch(/\bdocument_versions\b/u);
}

describe('relay-room service', () => {
  it('creates relay rooms and grants without cloud document rows and stores only token hashes', async () => {
    const { pool, queries, grants } = createRelayPool();

    const room = await createRelayRoom(pool, {
      state: 'host_offline',
      sharedRevision: 7,
      lastSharedHash: 'sha256:shared',
    });
    const grant = await createRelayGrant(pool, {
      relayRoomId: room.relayRoomId,
      role: 'edit',
      expiresAt: null,
    });

    expect(room).toMatchObject({
      relayRoomId: 'room_1',
      hostOnline: false,
      hostSessionId: null,
      sharedRevision: 7,
      lastSharedHash: 'sha256:shared',
    });
    expect(grant).toMatchObject({
      grantId: 'grant_1',
      relayRoomId: 'room_1',
      token: expect.stringMatching(/^ml_relay_/u),
      role: 'edit',
      expiresAt: null,
    });
    expect(grants[0]?.token_hash).toBe(hashRelayToken(grant.token));
    expect(grants[0]?.token_hash).not.toBe(grant.token);
    expect(JSON.stringify(grant)).not.toContain('tokenHash');
    expectNoCloudDocumentSql(queries);
  });

  it('verifies relay view and edit grants against relay_room_id only', async () => {
    const viewToken = 'ml_relay_view_secret';
    const editToken = 'ml_relay_edit_secret';
    const { pool, queries } = createRelayPool({
      rooms: [
        {
          id: 'room_1',
          host_session_id: null,
          state: 'host_online',
          last_ephemeral_yjs_state: null,
          last_shared_hash: 'sha256:rev-12',
          shared_revision: 12,
          created_at: createdAt,
          updated_at: updatedAt,
        },
      ],
      grants: [
        {
          id: 'grant_view',
          relay_room_id: 'room_1',
          token_hash: hashRelayToken(viewToken),
          role: 'view',
          expires_at: null,
          revoked_at: null,
          created_at: createdAt,
        },
        {
          id: 'grant_edit',
          relay_room_id: 'room_1',
          token_hash: hashRelayToken(editToken),
          role: 'edit',
          expires_at: null,
          revoked_at: null,
          created_at: createdAt,
        },
      ],
    });

    await expect(verifyRelayAccess(pool, viewToken, 'view')).resolves.toMatchObject({
      relayRoomId: 'room_1',
      grantId: 'grant_view',
      role: 'view',
      canView: true,
      canEdit: false,
      hostOnline: true,
      sharedRevision: 12,
      lastSharedHash: 'sha256:rev-12',
    });
    await expect(verifyRelayAccess(pool, viewToken, 'edit')).rejects.toThrow('forbidden');
    await expect(verifyRelayAccess(pool, editToken, 'edit')).resolves.toMatchObject({
      relayRoomId: 'room_1',
      grantId: 'grant_edit',
      role: 'edit',
      canEdit: true,
    });
    expectNoCloudDocumentSql(queries);
  });

  it('creates and updates host plus collaborator sessions for browser daemon and agent clients', async () => {
    const { pool, rooms, sessions } = createRelayPool({
      rooms: [
        {
          id: 'room_1',
          host_session_id: null,
          state: 'host_offline',
          last_ephemeral_yjs_state: null,
          last_shared_hash: null,
          shared_revision: 0,
          created_at: createdAt,
          updated_at: createdAt,
        },
      ],
      grants: [
        {
          id: 'grant_edit',
          relay_room_id: 'room_1',
          token_hash: 'sha256:unused',
          role: 'edit',
          expires_at: null,
          revoked_at: null,
          created_at: createdAt,
        },
      ],
      sessions: [],
    });

    await expect(
      createOrUpdateRelaySession(pool, {
        relayRoomId: 'room_1',
        role: 'host',
        clientId: 'daemon_host',
        clientKind: 'daemon',
        displayName: '  Host Mac  ',
      }),
    ).resolves.toMatchObject({
      relayRoomId: 'room_1',
      sessionId: 'session_1',
      grantId: null,
      clientKind: 'daemon',
      displayName: 'Host Mac',
      role: 'host',
    });
    expect(rooms[0]?.state).toBe('host_online');
    expect(rooms[0]?.host_session_id).toBe('session_1');

    await expect(
      createOrUpdateRelaySession(pool, {
        relayRoomId: 'room_1',
        grantId: 'grant_edit',
        clientId: 'browser_alex',
        clientKind: 'browser',
        displayName: '',
      }),
    ).resolves.toMatchObject({
      sessionId: 'session_2',
      grantId: 'grant_edit',
      clientKind: 'browser',
      displayName: 'Guest 1',
      role: 'edit',
    });

    await expect(
      createOrUpdateRelaySession(pool, {
        relayRoomId: 'room_1',
        grantId: 'grant_edit',
        clientId: 'agent_1',
        clientKind: 'agent',
        displayName: 'Codex',
      }),
    ).resolves.toMatchObject({
      sessionId: 'session_3',
      clientKind: 'agent',
      displayName: 'Codex',
      role: 'edit',
    });

    const repeat = await createOrUpdateRelaySession(pool, {
      relayRoomId: 'room_1',
      grantId: 'grant_edit',
      clientId: 'browser_alex',
      clientKind: 'browser',
      displayName: 'Alex',
    });

    expect(repeat).toMatchObject({
      sessionId: 'session_2',
      displayName: 'Alex',
      role: 'edit',
    });
    expect(sessions.map((session) => session.client_kind)).toEqual(['daemon', 'browser', 'agent']);
  });

  it('tracks host offline state plus shared revision and last shared hash', async () => {
    const { pool, rooms } = createRelayPool({
      rooms: [
        {
          id: 'room_1',
          host_session_id: 'session_host',
          state: 'host_online',
          last_ephemeral_yjs_state: null,
          last_shared_hash: 'sha256:old',
          shared_revision: 1,
          created_at: createdAt,
          updated_at: createdAt,
        },
      ],
    });

    await expect(
      updateRelaySharedState(pool, {
        relayRoomId: 'room_1',
        sharedRevision: 2,
        lastSharedHash: 'sha256:new',
        lastEphemeralYjsState: new Uint8Array([1, 2, 3]),
      }),
    ).resolves.toMatchObject({
      relayRoomId: 'room_1',
      sharedRevision: 2,
      lastSharedHash: 'sha256:new',
      hostOnline: true,
    });
    expect(Array.from(rooms[0]?.last_ephemeral_yjs_state ?? [])).toEqual([1, 2, 3]);

    await expect(setRelayHostOffline(pool, 'room_1')).resolves.toMatchObject({
      relayRoomId: 'room_1',
      hostOnline: false,
      hostSessionId: 'session_host',
      sharedRevision: 2,
      lastSharedHash: 'sha256:new',
    });
  });

  it('share-state hides raw token material and revoking one grant leaves unrelated grant and host metadata intact', async () => {
    const revokedToken = 'ml_relay_revoked_secret';
    const activeToken = 'ml_relay_active_secret';
    const { pool, grants } = createRelayPool({
      rooms: [
        {
          id: 'room_1',
          host_session_id: 'session_host',
          state: 'host_online',
          last_ephemeral_yjs_state: null,
          last_shared_hash: 'sha256:current',
          shared_revision: 9,
          created_at: createdAt,
          updated_at: updatedAt,
        },
      ],
      grants: [
        {
          id: 'grant_revoke',
          relay_room_id: 'room_1',
          token_hash: hashRelayToken(revokedToken),
          role: 'edit',
          expires_at: null,
          revoked_at: null,
          created_at: createdAt,
        },
        {
          id: 'grant_keep',
          relay_room_id: 'room_1',
          token_hash: hashRelayToken(activeToken),
          role: 'view',
          expires_at: null,
          revoked_at: null,
          created_at: createdAt,
        },
      ],
      sessions: [
        {
          id: 'session_host',
          grant_id: null,
          client_id: 'daemon_host',
          client_kind: 'daemon',
          display_name: 'Host Mac',
          color: '#111111',
          created_at: createdAt,
          last_seen_at: updatedAt,
        },
        {
          id: 'session_revoke',
          grant_id: 'grant_revoke',
          client_id: 'browser_1',
          client_kind: 'browser',
          display_name: 'Revoked User',
          color: '#222222',
          created_at: createdAt,
          last_seen_at: updatedAt,
        },
        {
          id: 'session_keep',
          grant_id: 'grant_keep',
          client_id: 'browser_2',
          client_kind: 'browser',
          display_name: 'Active User',
          color: '#333333',
          created_at: createdAt,
          last_seen_at: updatedAt,
        },
      ],
    });

    await expect(revokeRelayGrant(pool, 'grant_revoke')).resolves.toEqual({
      grantId: 'grant_revoke',
      relayRoomId: 'room_1',
      revoked: true,
    });
    expect(grants.find((grant) => grant.id === 'grant_keep')?.revoked_at).toBeNull();

    const state = await getRelayShareState(pool, {
      localPath: '/Users/fuyuming/project/README.md',
      relayRoomId: 'room_1',
    });

    expect(state).toMatchObject({
      localPath: '/Users/fuyuming/project/README.md',
      relayRoomId: 'room_1',
      hostOnline: true,
      hostSessionId: 'session_host',
      sharedRevision: 9,
      lastSharedHash: 'sha256:current',
    });
    expect(state.links).toEqual([
      expect.objectContaining({
        grantId: 'grant_revoke',
        role: 'edit',
        canCopyExistingUrl: false,
        revokedAt: iso(updatedAt),
        activeSessionCount: 0,
      }),
      expect.objectContaining({
        grantId: 'grant_keep',
        role: 'view',
        canCopyExistingUrl: false,
        revokedAt: null,
        activeSessionCount: 1,
      }),
    ]);
    expect(state.sessions).toEqual([
      expect.objectContaining({
        sessionId: 'session_host',
        grantId: null,
        clientKind: 'daemon',
        displayName: 'Host Mac',
        role: 'host',
      }),
      expect.objectContaining({
        sessionId: 'session_keep',
        grantId: 'grant_keep',
        clientKind: 'browser',
        displayName: 'Active User',
        role: 'view',
      }),
    ]);
    expect(JSON.stringify(state)).not.toContain(revokedToken);
    expect(JSON.stringify(state)).not.toContain(activeToken);
    expect(JSON.stringify(state)).not.toContain(hashRelayToken(revokedToken));
    expect(JSON.stringify(state)).not.toContain(hashRelayToken(activeToken));
    expect(JSON.stringify(state)).not.toContain('token_hash');
  });

  it('cleanup revokes expired grants, removes stale sessions, and does not touch local file metadata', async () => {
    const { pool, queries, grants, sessions, rooms } = createRelayPool({
      rooms: [
        {
          id: 'room_1',
          host_session_id: 'session_host',
          state: 'host_offline',
          last_ephemeral_yjs_state: new Uint8Array([1, 2, 3]),
          last_shared_hash: 'sha256:canonical',
          shared_revision: 4,
          created_at: createdAt,
          updated_at: '2026-05-01T11:00:00Z',
          ephemeral_cache_expires_at: '2026-05-01T12:00:00Z',
        } as RelayRoomRecord & { ephemeral_cache_expires_at: string },
      ],
      grants: [
        {
          id: 'grant_expired',
          relay_room_id: 'room_1',
          token_hash: hashRelayToken('ml_relay_expired'),
          role: 'edit',
          expires_at: '2026-05-01T12:00:00Z',
          revoked_at: null,
          created_at: createdAt,
        },
        {
          id: 'grant_active',
          relay_room_id: 'room_1',
          token_hash: hashRelayToken('ml_relay_active'),
          role: 'view',
          expires_at: '2026-05-02T12:00:00Z',
          revoked_at: null,
          created_at: createdAt,
        },
      ],
      sessions: [
        {
          id: 'session_expired',
          grant_id: 'grant_expired',
          client_id: 'old_editor',
          client_kind: 'browser',
          display_name: 'Old editor',
          color: '#111111',
          created_at: createdAt,
          last_seen_at: '2026-05-01T12:05:00Z',
        },
        {
          id: 'session_stale',
          grant_id: 'grant_active',
          client_id: 'stale_viewer',
          client_kind: 'browser',
          display_name: 'Stale viewer',
          color: '#222222',
          created_at: createdAt,
          last_seen_at: '2026-05-01T10:00:00Z',
        },
        {
          id: 'session_active',
          grant_id: 'grant_active',
          client_id: 'active_viewer',
          client_kind: 'browser',
          display_name: 'Active viewer',
          color: '#333333',
          created_at: createdAt,
          last_seen_at: '2026-05-01T12:30:00Z',
        },
      ],
    });

    await expect(
      cleanupExpiredRelayState(pool, {
        now: new Date('2026-05-01T13:00:00Z'),
        staleSessionTtlMs: 60 * 60 * 1000,
      }),
    ).resolves.toEqual({
      expiredGrants: 1,
      staleSessions: 2,
      expiredEphemeralRooms: 1,
    });

    expect(grants.find((grant) => grant.id === 'grant_expired')?.revoked_at).toEqual(new Date('2026-05-01T13:00:00Z'));
    expect(sessions.map((session) => session.id)).toEqual(['session_active']);
    expect(rooms[0]?.last_ephemeral_yjs_state).toBeNull();
    expect(rooms[0]?.last_shared_hash).toBe('sha256:canonical');
    expect(rooms[0]?.shared_revision).toBe(4);

    const sql = queries.map((query) => query.sql).join('\n');
    expect(sql).not.toMatch(/local/i);
    expect(sql).not.toMatch(/metadata/i);
    expectNoCloudDocumentSql(queries);
  });
});
