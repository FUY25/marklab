import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { DbPool, DbQueryResult, DbTransactionClient } from '../db/client';
import { createHttpApp } from '../http/app';
import { hashToken } from '../services/access-control';
import { createUnavailableLiveMarkdownWriter } from '../services/live-writer';

type WorkspaceRole = 'Owner' | 'Member' | 'Reader';

interface UserRecord {
  id: string;
  email: string;
  display_name: string;
}

interface WorkspaceRecord {
  id: string;
  name: string;
  owner_user_id: string;
}

interface MemberRecord {
  workspace_id: string;
  user_id: string;
  role: WorkspaceRole;
}

interface ShareKeyRecord {
  id: string;
  workspace_id: string;
  token_hash: string;
  role: WorkspaceRole;
  expires_at: Date | string | null;
  revoked_at: Date | string | null;
}

interface CapturedQuery {
  sql: string;
  params?: readonly unknown[];
}

function createWorkspacePool() {
  const calls: CapturedQuery[] = [];
  const users: UserRecord[] = [
    { id: 'user_owner', email: 'owner@example.com', display_name: 'Owner' },
    { id: 'user_member', email: 'member@example.com', display_name: 'Member' },
    { id: 'user_reader', email: 'reader@example.com', display_name: 'Reader' },
  ];
  const sessions = new Map([
    [hashToken('owner-token'), 'user_owner'],
    [hashToken('member-token'), 'user_member'],
    [hashToken('reader-token'), 'user_reader'],
  ]);
  const workspaces: WorkspaceRecord[] = [
    { id: 'ws_existing', name: 'Existing', owner_user_id: 'user_owner' },
  ];
  const members: MemberRecord[] = [
    { workspace_id: 'ws_existing', user_id: 'user_owner', role: 'Owner' },
    { workspace_id: 'ws_existing', user_id: 'user_reader', role: 'Reader' },
  ];
  const shareKeys: ShareKeyRecord[] = [];
  const documents = [
    { id: 'doc_1', title: 'Alpha', default_branch_id: 'branch_1', workspace_id: 'ws_existing' },
  ];
  const grants = [
    { doc_id: 'doc_1', role: 'view', expires_at: null, revoked_at: null },
    { doc_id: 'doc_1', role: 'edit', expires_at: null, revoked_at: null },
    { doc_id: 'doc_1', role: 'view', expires_at: '2026-05-10T00:00:00.000Z', revoked_at: null },
    { doc_id: 'doc_1', role: 'edit', expires_at: '2026-05-10T00:00:00.000Z', revoked_at: null },
    { doc_id: 'doc_1', role: 'edit', expires_at: null, revoked_at: '2026-05-11T00:00:00.000Z' },
  ];
  const subscriptions = [{ workspace_id: 'ws_existing', plan_id: 'free', status: 'manual', current_period_end: null as string | null }];
  const seatLimits = new Map([
    ['free', 2],
    ['business', 50],
  ]);
  const advisoryLocks: string[] = [];
  let nextWorkspaceId = 1;
  let nextShareKeyId = 1;

  const query: DbPool['query'] = async <Row = unknown>(sql: string, params?: readonly unknown[]): Promise<DbQueryResult<Row>> => {
    calls.push(params === undefined ? { sql } : { sql, params });
    if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return { rows: [], rowCount: 0 };

    if (sql.includes('pg_advisory_xact_lock')) {
      advisoryLocks.push(String(params?.[0]));
      return { rows: [], rowCount: 1 };
    }

    if (params?.includes('not-a-uuid')) {
      const error = new Error('invalid input syntax for type uuid') as Error & { code: string };
      error.code = '22P02';
      throw error;
    }

    if (sql.includes('update user_sessions') && sql.includes('from users')) {
      const userId = sessions.get(String(params?.[0]));
      const user = users.find((candidate) => candidate.id === userId);
      if (!user) return { rows: [], rowCount: 0 };
      return { rows: [{ session_id: 'session', id: user.id, email: user.email, display_name: user.display_name } as Row], rowCount: 1 };
    }

    if (sql.includes('insert into workspaces')) {
      const row = { id: `ws_${nextWorkspaceId++}`, name: String(params?.[0]), owner_user_id: String(params?.[1]), role: 'Owner' };
      workspaces.push(row);
      return { rows: [row as Row], rowCount: 1 };
    }

    if (sql.includes('insert into workspace_members') && sql.includes("values ($1, $2, 'Owner')")) {
      const existing = members.find((member) => member.workspace_id === params?.[0] && member.user_id === params?.[1]);
      if (existing) existing.role = 'Owner';
      else members.push({ workspace_id: String(params?.[0]), user_id: String(params?.[1]), role: 'Owner' });
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes('insert into subscriptions')) {
      subscriptions.push({ workspace_id: String(params?.[0]), plan_id: 'free', status: 'manual', current_period_end: null });
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes('select role') && sql.includes('from workspace_members')) {
      const role = members.find((member) => member.workspace_id === params?.[0] && member.user_id === params?.[1])?.role;
      return { rows: role ? [{ role } as Row] : [], rowCount: role ? 1 : 0 };
    }

    if (sql.includes('select m.user_id') && sql.includes('join users')) {
      const rows = members
        .filter((member) => member.workspace_id === params?.[0])
        .map((member) => {
          const user = users.find((candidate) => candidate.id === member.user_id)!;
          return { user_id: user.id, email: user.email, display_name: user.display_name, role: member.role };
        });
      return { rows: rows as Row[], rowCount: rows.length };
    }

    if (sql.includes('insert into workspace_share_keys')) {
      const row: ShareKeyRecord = {
        id: `wsk_${nextShareKeyId++}`,
        workspace_id: String(params?.[0]),
        token_hash: String(params?.[1]),
        role: params?.[2] as WorkspaceRole,
        expires_at: (params?.[4] as string | null | undefined) ?? null,
        revoked_at: null,
      };
      shareKeys.push(row);
      return { rows: [row as Row], rowCount: 1 };
    }

    if (sql.includes('update workspace_share_keys') && sql.includes('set revoked_at = now()')) {
      const key = shareKeys.find((candidate) => candidate.id === params?.[0] && candidate.workspace_id === params?.[1] && !candidate.revoked_at);
      if (!key) return { rows: [], rowCount: 0 };
      key.revoked_at = '2026-05-11T12:00:00.000Z';
      return { rows: [{ id: key.id } as Row], rowCount: 1 };
    }

    if (sql.includes('from workspace_share_keys') && !sql.includes('seat_limits')) {
      const key = shareKeys.find((candidate) => candidate.token_hash === params?.[0] && !candidate.revoked_at);
      if (!key) return { rows: [], rowCount: 0 };
      return { rows: [{ workspace_id: key.workspace_id } as Row], rowCount: 1 };
    }

    if (sql.includes('from workspace_share_keys')) {
      expect(sql).toContain("s.status in ('manual', 'trialing', 'active')");
      expect(sql).toContain('(s.current_period_end is null or s.current_period_end > now())');
      const key = shareKeys.find((candidate) => candidate.token_hash === params?.[0] && !candidate.revoked_at);
      if (!key) return { rows: [], rowCount: 0 };
      const subscription = subscriptions.find((candidate) => candidate.workspace_id === key.workspace_id);
      const usableSubscription = subscription
        && ['manual', 'trialing', 'active'].includes(subscription.status)
        && (!subscription.current_period_end || new Date(subscription.current_period_end).getTime() > Date.now())
        ? subscription
        : undefined;
      return {
        rows: [{
          workspace_id: key.workspace_id,
          role: key.role,
          member_seats: seatLimits.get(usableSubscription?.plan_id ?? 'free') ?? 1,
        } as Row],
        rowCount: 1,
      };
    }

    if (sql.includes('select count(*) as member_count')) {
      const count = members.filter((member) => member.workspace_id === params?.[0]).length;
      return { rows: [{ member_count: String(count) } as Row], rowCount: 1 };
    }

    if (sql.includes('insert into workspace_members') && sql.includes('values ($1, $2, $3)')) {
      members.push({ workspace_id: String(params?.[0]), user_id: String(params?.[1]), role: params?.[2] as WorkspaceRole });
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes('select w.id') && sql.includes('join workspace_members m')) {
      const workspace = workspaces.find((candidate) => candidate.id === params?.[0]);
      const member = members.find((candidate) => candidate.workspace_id === params?.[0] && candidate.user_id === params?.[1]);
      if (!workspace || !member) return { rows: [], rowCount: 0 };
      return { rows: [{ id: workspace.id, name: workspace.name, role: member.role } as Row], rowCount: 1 };
    }

    if (sql.includes('count(*) filter (where role =')) {
      const workspaceMembers = members.filter((member) => member.workspace_id === params?.[0]);
      const target = workspaceMembers.find((member) => member.user_id === params?.[1]);
      return {
        rows: [{
          owner_count: workspaceMembers.filter((member) => member.role === 'Owner').length,
          target_role: target?.role ?? null,
        } as Row],
        rowCount: 1,
      };
    }

    if (sql.includes('update workspace_members m')) {
      const member = members.find((candidate) => candidate.workspace_id === params?.[0] && candidate.user_id === params?.[1]);
      const user = users.find((candidate) => candidate.id === params?.[1]);
      if (!member || !user) return { rows: [], rowCount: 0 };
      member.role = params?.[2] as WorkspaceRole;
      return { rows: [{ user_id: user.id, email: user.email, display_name: user.display_name, role: member.role } as Row], rowCount: 1 };
    }

    if (sql.includes('delete from workspace_members')) {
      const index = members.findIndex((candidate) => candidate.workspace_id === params?.[0] && candidate.user_id === params?.[1]);
      if (index < 0) return { rows: [], rowCount: 0 };
      members.splice(index, 1);
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes('from documents d') && sql.includes('left join document_access_grants')) {
      expect(sql).toContain('(g.expires_at is null or g.expires_at > now())');
      const active = (grant: typeof grants[number]) => !grant.revoked_at && (!grant.expires_at || new Date(grant.expires_at).getTime() > Date.now());
      const rows = documents
        .filter((document) => document.workspace_id === params?.[0])
        .map((document) => ({
          id: document.id,
          title: document.title,
          default_branch_id: document.default_branch_id,
          view_grant_count: grants.filter((grant) => grant.doc_id === document.id && grant.role === 'view' && active(grant)).length,
          edit_grant_count: grants.filter((grant) => grant.doc_id === document.id && grant.role === 'edit' && active(grant)).length,
        }));
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

  return { pool, calls, members, shareKeys, advisoryLocks, seatLimits, subscriptions };
}

describe('workspace routes', () => {
  it('lets a logged-in user create a workspace as Owner', async () => {
    const { pool, members } = createWorkspacePool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter());

    const response = await request(app)
      .post('/api/workspaces')
      .set({ Authorization: 'Bearer owner-token' })
      .send({ name: 'New Workspace' })
      .expect(201);

    expect(response.body.workspace).toEqual({
      workspaceId: 'ws_1',
      name: 'New Workspace',
      role: 'Owner',
    });
    expect(members).toContainEqual({ workspace_id: 'ws_1', user_id: 'user_owner', role: 'Owner' });
  });

  it('supports the owner settings contract for members, share keys, roles, removal, and documents', async () => {
    const { pool, members, shareKeys, advisoryLocks } = createWorkspacePool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter());
    const owner = { Authorization: 'Bearer owner-token' };

    const membersResponse = await request(app)
      .get('/api/workspaces/ws_existing/members')
      .set(owner)
      .expect(200);
    expect(membersResponse.body.members.map((member: { userId: string; role: WorkspaceRole }) => [member.userId, member.role])).toEqual([
      ['user_owner', 'Owner'],
      ['user_reader', 'Reader'],
    ]);

    const keyResponse = await request(app)
      .post('/api/workspaces/ws_existing/share-keys')
      .set(owner)
      .send({ role: 'Member' })
      .expect(201);
    expect(keyResponse.body.key).toMatchObject({
      keyId: 'wsk_1',
      token: expect.stringMatching(/^ml_workspace_/u),
      role: 'Member',
      expiresAt: null,
    });
    expect(shareKeys[0]?.token_hash).toBe(hashToken(keyResponse.body.key.token));

    members.find((member) => member.user_id === 'user_reader')!.role = 'Member';
    const updateResponse = await request(app)
      .patch('/api/workspaces/ws_existing/members/user_reader')
      .set(owner)
      .send({ role: 'Reader' })
      .expect(200);
    expect(updateResponse.body.member.role).toBe('Reader');

    const documentsResponse = await request(app)
      .get('/api/workspaces/ws_existing/documents')
      .set(owner)
      .expect(200);
    expect(documentsResponse.body.documents).toEqual([
      {
        docId: 'doc_1',
        title: 'Alpha',
        defaultBranchId: 'branch_1',
        viewGrantCount: 1,
        editGrantCount: 1,
      },
    ]);

    await request(app)
      .delete('/api/workspaces/ws_existing/members/user_reader')
      .set(owner)
      .expect(204);
    expect(members.some((member) => member.user_id === 'user_reader')).toBe(false);
    expect(advisoryLocks).toContain('workspace_members:ws_existing');
  });

  it('returns a bad request instead of internal_error for invalid workspace ids', async () => {
    const { pool } = createWorkspacePool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter());

    await request(app)
      .get('/api/workspaces/not-a-uuid/members')
      .set({ Authorization: 'Bearer owner-token' })
      .expect(400, { error: 'invalid_request' });
  });

  it('rejects owner workspace share keys because bearer invites cannot elevate ownership', async () => {
    const { pool } = createWorkspacePool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter());

    await request(app)
      .post('/api/workspaces/ws_existing/share-keys')
      .set({ Authorization: 'Bearer owner-token' })
      .send({ role: 'Owner' })
      .expect(400);
  });

  it('rejects legacy owner workspace share keys during join', async () => {
    const { pool, members, seatLimits, shareKeys } = createWorkspacePool();
    seatLimits.set('free', 3);
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter());
    shareKeys.push({
      id: 'wsk_legacy_owner',
      workspace_id: 'ws_existing',
      token_hash: hashToken('ml_workspace_legacy_owner_key'),
      role: 'Owner',
      expires_at: null,
      revoked_at: null,
    });

    await request(app)
      .post('/api/workspaces/join')
      .set({ Authorization: 'Bearer member-token' })
      .send({ token: 'ml_workspace_legacy_owner_key' })
      .expect(403, { error: 'forbidden' });

    expect(members.some((member) => member.user_id === 'user_member')).toBe(false);
  });

  it('forbids non-owners from sensitive settings actions', async () => {
    const { pool, advisoryLocks } = createWorkspacePool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter());
    const reader = { Authorization: 'Bearer reader-token' };

    await request(app)
      .post('/api/workspaces/ws_existing/share-keys')
      .set(reader)
      .send({ role: 'Member' })
      .expect(403, { error: 'forbidden' });

    await request(app)
      .patch('/api/workspaces/ws_existing/members/user_reader')
      .set(reader)
      .send({ role: 'Member' })
      .expect(403, { error: 'forbidden' });

    await request(app)
      .delete('/api/workspaces/ws_existing/members/user_reader')
      .set(reader)
      .expect(403, { error: 'forbidden' });
  });

  it('enforces member-seat limits when joining with a workspace share key', async () => {
    const { pool, advisoryLocks } = createWorkspacePool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter());
    const owner = { Authorization: 'Bearer owner-token' };

    const keyResponse = await request(app)
      .post('/api/workspaces/ws_existing/share-keys')
      .set(owner)
      .send({ role: 'Member' })
      .expect(201);

    await request(app)
      .post('/api/workspaces/join')
      .set({ Authorization: 'Bearer member-token' })
      .send({ token: keyResponse.body.key.token })
      .expect(429, { error: 'member_seat_limit_exceeded' });
    expect(advisoryLocks).toContain('workspace_members:ws_existing');
  });

  it('does not apply paid member-seat limits after a subscription is canceled', async () => {
    const { pool, subscriptions } = createWorkspacePool();
    subscriptions[0]!.plan_id = 'business';
    subscriptions[0]!.status = 'canceled';
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter());

    const keyResponse = await request(app)
      .post('/api/workspaces/ws_existing/share-keys')
      .set({ Authorization: 'Bearer owner-token' })
      .send({ role: 'Member' })
      .expect(201);

    await request(app)
      .post('/api/workspaces/join')
      .set({ Authorization: 'Bearer member-token' })
      .send({ token: keyResponse.body.key.token })
      .expect(429, { error: 'member_seat_limit_exceeded' });
  });

  it('lets a logged-in user join a workspace with a valid share key', async () => {
    const { pool, calls, members, seatLimits, advisoryLocks } = createWorkspacePool();
    seatLimits.set('free', 3);
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter());
    const owner = { Authorization: 'Bearer owner-token' };

    const keyResponse = await request(app)
      .post('/api/workspaces/ws_existing/share-keys')
      .set(owner)
      .send({ role: 'Member' })
      .expect(201);
    calls.length = 0;

    const joinResponse = await request(app)
      .post('/api/workspaces/join')
      .set({ Authorization: 'Bearer member-token' })
      .send({ token: keyResponse.body.key.token })
      .expect(201);

    expect(joinResponse.body.workspace).toEqual({
      workspaceId: 'ws_existing',
      name: 'Existing',
      role: 'Member',
    });
    expect(members).toContainEqual({ workspace_id: 'ws_existing', user_id: 'user_member', role: 'Member' });
    expect(advisoryLocks).toContain('workspace_members:ws_existing');
    const lockIndex = calls.findIndex((call) => call.sql.includes('pg_advisory_xact_lock'));
    const rowLockIndex = calls.findIndex((call) =>
      call.sql.includes('from workspace_share_keys') && call.sql.includes('for update of k'),
    );
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(rowLockIndex).toBeGreaterThanOrEqual(0);
    expect(lockIndex).toBeLessThan(rowLockIndex);
  });

  it('lets owners revoke workspace share keys before they are used again', async () => {
    const { pool, shareKeys, seatLimits } = createWorkspacePool();
    seatLimits.set('free', 3);
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter());
    const owner = { Authorization: 'Bearer owner-token' };

    const keyResponse = await request(app)
      .post('/api/workspaces/ws_existing/share-keys')
      .set(owner)
      .send({ role: 'Member' })
      .expect(201);

    await request(app)
      .delete('/api/workspaces/ws_existing/share-keys/wsk_1')
      .set(owner)
      .expect(204);

    expect(shareKeys[0]?.revoked_at).toBe('2026-05-11T12:00:00.000Z');

    await request(app)
      .post('/api/workspaces/join')
      .set({ Authorization: 'Bearer member-token' })
      .send({ token: keyResponse.body.key.token })
      .expect(404, { error: 'workspace_share_key_not_found' });
  });

  it('requires a logged-in user for workspace APIs', async () => {
    const { pool } = createWorkspacePool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter());

    await request(app)
      .post('/api/workspaces')
      .send({ name: 'No Session' })
      .expect(401, { error: 'unauthorized' });
  });
});
