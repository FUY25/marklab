import { randomBytes } from 'node:crypto';
import type { DbExecutor, DbPool } from '../db/client';
import { withTransaction } from '../db/client';
import { hashToken } from './access-control';
import { requireWorkspaceRole, type WorkspaceRole } from './control-plane-access';

export interface WorkspaceSummary {
  workspaceId: string;
  name: string;
  role: WorkspaceRole;
}

export interface WorkspaceMemberSummary {
  userId: string;
  email: string | null;
  displayName: string;
  role: WorkspaceRole;
}

export interface WorkspaceShareKey {
  keyId: string;
  token: string;
  role: WorkspaceRole;
  expiresAt: string | null;
}

export interface WorkspaceDocumentSummary {
  docId: string;
  title: string;
  defaultBranchId: string | null;
  viewGrantCount: number;
  editGrantCount: number;
}

interface WorkspaceRow {
  id: string;
  name: string;
  role: WorkspaceRole;
}

interface MemberRow {
  user_id: string;
  email: string | null;
  display_name: string;
  role: WorkspaceRole;
}

interface ShareKeyRow {
  id: string;
  role: WorkspaceRole;
  expires_at: Date | string | null;
}

interface JoinKeyRow {
  workspace_id: string;
  role: WorkspaceRole;
  member_seats: string | number;
}

interface DocumentRow {
  id: string;
  title: string;
  default_branch_id: string | null;
  view_grant_count: string | number;
  edit_grant_count: string | number;
}

function workspaceToken(): string {
  return `ml_workspace_${randomBytes(32).toString('base64url')}`;
}

function toIsoString(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toWorkspace(row: WorkspaceRow): WorkspaceSummary {
  return {
    workspaceId: row.id,
    name: row.name,
    role: row.role,
  };
}

function toMember(row: MemberRow): WorkspaceMemberSummary {
  return {
    userId: row.user_id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
  };
}

function toDocument(row: DocumentRow): WorkspaceDocumentSummary {
  return {
    docId: row.id,
    title: row.title,
    defaultBranchId: row.default_branch_id,
    viewGrantCount: Number(row.view_grant_count),
    editGrantCount: Number(row.edit_grant_count),
  };
}

async function assertNotRemovingLastOwner(client: DbExecutor, workspaceId: string, targetUserId: string): Promise<void> {
  const result = await client.query<{ owner_count: string | number; target_role: WorkspaceRole | null }>(
    `select count(*) filter (where role = 'Owner') as owner_count,
            max(role) filter (where user_id = $2) as target_role
       from workspace_members
      where workspace_id = $1`,
    [workspaceId, targetUserId],
  );
  const row = result.rows[0];
  if (row?.target_role === 'Owner' && Number(row.owner_count) <= 1) throw new Error('last_owner_required');
}

async function lockWorkspaceMembershipScope(client: DbExecutor, workspaceId: string): Promise<void> {
  await client.query(
    `select pg_advisory_xact_lock(hashtext($1)::bigint)`,
    [`workspace_members:${workspaceId}`],
  );
}

export async function createWorkspace(pool: DbPool, input: { userId: string; name: string }): Promise<WorkspaceSummary> {
  return withTransaction(pool, async (client) => {
    const created = await client.query<WorkspaceRow>(
      `insert into workspaces
         (name, owner_user_id)
       values ($1, $2)
       returning id, name, 'Owner'::text as role`,
      [input.name, input.userId],
    );
    const workspace = created.rows[0];
    if (!workspace) throw new Error('workspace_insert_failed');
    await client.query(
      `insert into workspace_members
         (workspace_id, user_id, role)
       values ($1, $2, 'Owner')
       on conflict (workspace_id, user_id) do update
         set role = 'Owner',
             updated_at = now()`,
      [workspace.id, input.userId],
    );
    await client.query(
      `insert into subscriptions
         (workspace_id, plan_id, status)
       values ($1, 'free', 'manual')
       on conflict (workspace_id) do nothing`,
      [workspace.id],
    );
    return toWorkspace(workspace);
  });
}

export async function listWorkspaceMembers(pool: DbExecutor, input: { workspaceId: string; userId: string }): Promise<WorkspaceMemberSummary[]> {
  await requireWorkspaceRole(pool, { workspaceId: input.workspaceId, userId: input.userId, allowed: ['Owner', 'Member', 'Reader'] });
  const result = await pool.query<MemberRow>(
    `select m.user_id,
            u.email,
            u.display_name,
            m.role
       from workspace_members m
       join users u on u.id = m.user_id
      where m.workspace_id = $1
      order by case m.role when 'Owner' then 0 when 'Member' then 1 else 2 end,
               lower(u.display_name),
               u.email`,
    [input.workspaceId],
  );
  return result.rows.map(toMember);
}

export async function createWorkspaceShareKey(pool: DbPool, input: {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  expiresAt?: string | null;
}): Promise<WorkspaceShareKey> {
  if (input.role === 'Owner') throw new Error('forbidden');
  return withTransaction(pool, async (client) => {
    await lockWorkspaceMembershipScope(client, input.workspaceId);
    await requireWorkspaceRole(client, { workspaceId: input.workspaceId, userId: input.userId, allowed: ['Owner'] });
    const token = workspaceToken();
    const result = await client.query<ShareKeyRow>(
      `insert into workspace_share_keys
         (workspace_id, token_hash, role, created_by_user_id, expires_at)
       values ($1, $2, $3, $4, $5)
       returning id, role, expires_at`,
      [input.workspaceId, hashToken(token), input.role, input.userId, input.expiresAt ?? null],
    );
    const row = result.rows[0];
    if (!row) throw new Error('workspace_share_key_insert_failed');
    return {
      keyId: row.id,
      token,
      role: row.role,
      expiresAt: toIsoString(row.expires_at),
    };
  });
}

export async function joinWorkspaceWithShareKey(pool: DbPool, input: { userId: string; token: string }): Promise<WorkspaceSummary> {
  return withTransaction(pool, async (client) => {
    const tokenHash = hashToken(input.token);
    const scopeResult = await client.query<{ workspace_id: string }>(
      `select k.workspace_id
         from workspace_share_keys k
        where k.token_hash = $1
          and k.revoked_at is null
          and (k.expires_at is null or k.expires_at > now())`,
      [tokenHash],
    );
    const scope = scopeResult.rows[0];
    if (!scope) throw new Error('workspace_share_key_not_found');
    await lockWorkspaceMembershipScope(client, scope.workspace_id);

    const keyResult = await client.query<JoinKeyRow>(
      `select k.workspace_id,
              k.role,
              coalesce(sl.member_seats, 1) as member_seats
         from workspace_share_keys k
         left join subscriptions s on s.workspace_id = k.workspace_id
          and s.status in ('manual', 'trialing', 'active')
          and (s.current_period_end is null or s.current_period_end > now())
       left join seat_limits sl on sl.plan_id = coalesce(s.plan_id, 'free')
        where k.token_hash = $1
          and k.workspace_id = $2
          and k.revoked_at is null
          and (k.expires_at is null or k.expires_at > now())
        for update of k`,
      [tokenHash, scope.workspace_id],
    );
    const key = keyResult.rows[0];
    if (!key) throw new Error('workspace_share_key_not_found');
    if (key.role === 'Owner') throw new Error('forbidden');

    const existing = await client.query<{ role: WorkspaceRole }>(
      `select role
         from workspace_members
        where workspace_id = $1
          and user_id = $2`,
      [key.workspace_id, input.userId],
    );
    if (!existing.rows[0]) {
      const counted = await client.query<{ member_count: string | number }>(
        `select count(*) as member_count
           from workspace_members
          where workspace_id = $1`,
        [key.workspace_id],
      );
      if (Number(counted.rows[0]?.member_count ?? 0) >= Number(key.member_seats)) throw new Error('member_seat_limit_exceeded');
      await client.query(
        `insert into workspace_members
           (workspace_id, user_id, role)
         values ($1, $2, $3)`,
        [key.workspace_id, input.userId, key.role],
      );
    }

    const workspace = await client.query<WorkspaceRow>(
      `select w.id,
              w.name,
              m.role
         from workspaces w
         join workspace_members m
           on m.workspace_id = w.id
          and m.user_id = $2
        where w.id = $1`,
      [key.workspace_id, input.userId],
    );
    const row = workspace.rows[0];
    if (!row) throw new Error('workspace_not_found');
    return toWorkspace(row);
  });
}

export async function revokeWorkspaceShareKey(pool: DbPool, input: {
  workspaceId: string;
  userId: string;
  keyId: string;
}): Promise<void> {
  await withTransaction(pool, async (client) => {
    await lockWorkspaceMembershipScope(client, input.workspaceId);
    await requireWorkspaceRole(client, { workspaceId: input.workspaceId, userId: input.userId, allowed: ['Owner'] });
    const revoked = await client.query<{ id: string }>(
      `update workspace_share_keys
          set revoked_at = now()
        where id = $1
          and workspace_id = $2
          and revoked_at is null
        returning id`,
      [input.keyId, input.workspaceId],
    );
    if (!revoked.rows[0]) throw new Error('workspace_share_key_not_found');
  });
}

export async function updateWorkspaceMemberRole(pool: DbPool, input: {
  workspaceId: string;
  actorUserId: string;
  targetUserId: string;
  role: WorkspaceRole;
}): Promise<WorkspaceMemberSummary> {
  return withTransaction(pool, async (client) => {
    await lockWorkspaceMembershipScope(client, input.workspaceId);
    await requireWorkspaceRole(client, { workspaceId: input.workspaceId, userId: input.actorUserId, allowed: ['Owner'] });
    if (input.role !== 'Owner') await assertNotRemovingLastOwner(client, input.workspaceId, input.targetUserId);
    const updated = await client.query<MemberRow>(
      `update workspace_members m
          set role = $3,
              updated_at = now()
         from users u
        where m.user_id = u.id
          and m.workspace_id = $1
          and m.user_id = $2
        returning m.user_id, u.email, u.display_name, m.role`,
      [input.workspaceId, input.targetUserId, input.role],
    );
    const row = updated.rows[0];
    if (!row) throw new Error('workspace_member_not_found');
    return toMember(row);
  });
}

export async function removeWorkspaceMember(pool: DbPool, input: {
  workspaceId: string;
  actorUserId: string;
  targetUserId: string;
}): Promise<void> {
  await withTransaction(pool, async (client) => {
    await lockWorkspaceMembershipScope(client, input.workspaceId);
    await requireWorkspaceRole(client, { workspaceId: input.workspaceId, userId: input.actorUserId, allowed: ['Owner'] });
    await assertNotRemovingLastOwner(client, input.workspaceId, input.targetUserId);
    const deleted = await client.query(
      `delete from workspace_members
        where workspace_id = $1
          and user_id = $2`,
      [input.workspaceId, input.targetUserId],
    );
    if ((deleted.rowCount ?? 0) === 0) throw new Error('workspace_member_not_found');
  });
}

export async function listWorkspaceDocuments(pool: DbExecutor, input: {
  workspaceId: string;
  userId: string;
}): Promise<WorkspaceDocumentSummary[]> {
  await requireWorkspaceRole(pool, { workspaceId: input.workspaceId, userId: input.userId, allowed: ['Owner', 'Member', 'Reader'] });
  const result = await pool.query<DocumentRow>(
    `select d.id,
            d.title,
            d.default_branch_id,
	            count(g.id) filter (
	              where g.role = 'view'
	                and g.revoked_at is null
	                and (g.expires_at is null or g.expires_at > now())
	            ) as view_grant_count,
	            count(g.id) filter (
	              where g.role = 'edit'
	                and g.revoked_at is null
	                and (g.expires_at is null or g.expires_at > now())
	            ) as edit_grant_count
       from documents d
       left join document_access_grants g on g.doc_id = d.id
      where d.workspace_id = $1
      group by d.id, d.title, d.default_branch_id
      order by d.updated_at desc, d.created_at desc`,
    [input.workspaceId],
  );
  return result.rows.map(toDocument);
}
