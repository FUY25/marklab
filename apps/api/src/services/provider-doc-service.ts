import { randomUUID } from 'node:crypto';
import type { DbExecutor, DbPool } from '../db/client';
import { withTransaction } from '../db/client';

export const LEGACY_DOCUMENT_QUOTA_KEY_PREFIX = 'legacy:marklab-alpha-doc:';

export interface ProviderDocIdentity {
  providerDocId: string;
  created: boolean;
  needsSeed: boolean;
  initialYjsState: Uint8Array;
}

export async function ensureProviderDocId(pool: DbExecutor, input: {
  docId: string;
  branchId: string;
}): Promise<ProviderDocIdentity> {
  const existing = await pool.query<{
    provider_doc_id: string | null;
    provider_doc_seeded_at: Date | string | null;
    yjs_state: Buffer | Uint8Array;
  }>(
    `select s.provider_doc_id, s.provider_doc_seeded_at, s.yjs_state
       from document_branch_states s
       join document_branches b
         on b.id = s.branch_id
        and b.doc_id = $2
        and b.is_archived = false
      where s.branch_id = $1`,
    [input.branchId, input.docId],
  );

  const existingRow = existing.rows[0];
  if (!existingRow) throw new Error('branch_not_found');
  if (existingRow.provider_doc_id) {
    return {
      providerDocId: existingRow.provider_doc_id,
      created: false,
      needsSeed: !existingRow.provider_doc_seeded_at,
      initialYjsState: new Uint8Array(existingRow.yjs_state),
    };
  }

  const generated = `ml_doc_${randomUUID()}`;
  const updated = await pool.query<{
    provider_doc_id: string;
    provider_doc_seeded_at: Date | string | null;
    yjs_state: Buffer | Uint8Array;
  }>(
    `update document_branch_states s
        set provider_doc_id = coalesce(s.provider_doc_id, $3),
            provider_doc_seeded_at = case
              when s.provider_doc_id is null then null
              else s.provider_doc_seeded_at
            end,
            updated_at = now()
       from document_branches b
      where s.branch_id = $1
        and b.id = s.branch_id
        and b.doc_id = $2
        and b.is_archived = false
      returning s.provider_doc_id, s.provider_doc_seeded_at, s.yjs_state`,
    [input.branchId, input.docId, generated],
  );

  const row = updated.rows[0];
  if (!row) throw new Error('branch_not_found');
  return {
    providerDocId: row.provider_doc_id,
    created: row.provider_doc_id === generated,
    needsSeed: !row.provider_doc_seeded_at,
    initialYjsState: new Uint8Array(row.yjs_state),
  };
}

export async function markProviderDocSeeded(pool: DbExecutor, input: {
  docId: string;
  branchId: string;
  providerDocId: string;
  seededYjsState: Uint8Array;
}): Promise<void> {
  const updated = await pool.query(
    `update document_branch_states s
        set provider_doc_seeded_at = now(),
            updated_at = now()
       from document_branches b
      where s.branch_id = $1
        and b.id = s.branch_id
        and b.doc_id = $2
        and b.is_archived = false
        and s.provider_doc_id = $3
        and s.yjs_state = $4`,
    [input.branchId, input.docId, input.providerDocId, Buffer.from(input.seededYjsState)],
  );
  if ((updated.rowCount ?? 0) === 0) throw new Error('provider_doc_seed_stale');
}

export async function lockProviderDocSeedScope(pool: DbExecutor, input: {
  docId: string;
  branchId: string;
}): Promise<void> {
  await pool.query(
    `select pg_advisory_xact_lock(hashtext($1)::bigint)`,
    [`provider_doc_seed:${input.docId}:${input.branchId}`],
  );
}

export interface ProviderDocSeedState {
  seededAt: Date | string | null;
  initialYjsState: Uint8Array;
}

export async function readProviderDocSeedStateForUpdate(pool: DbExecutor, input: {
  docId: string;
  branchId: string;
  providerDocId: string;
}): Promise<ProviderDocSeedState> {
  const locked = await pool.query<{
    provider_doc_seeded_at: Date | string | null;
    yjs_state: Buffer | Uint8Array;
  }>(
    `select s.provider_doc_seeded_at, s.yjs_state
       from document_branch_states s
       join document_branches b
         on b.id = s.branch_id
        and b.doc_id = $2
        and b.is_archived = false
      where s.branch_id = $1
        and s.provider_doc_id = $3
      for update of s`,
    [input.branchId, input.docId, input.providerDocId],
  );
  const row = locked.rows[0];
  if (!row) throw new Error('provider_doc_seed_stale');
  return {
    seededAt: row.provider_doc_seeded_at,
    initialYjsState: new Uint8Array(row.yjs_state),
  };
}

export type ProviderTokenClientKind = 'browser' | 'app' | 'daemon' | 'agent' | 'guest';

export interface ActiveProviderTokenSession {
  providerDocId: string;
  clientKind: ProviderTokenClientKind;
  actorType: 'agent' | 'user';
  actorId: string | null;
  actorGrantId: string | null;
  isGuest: boolean;
  displayName: string;
  status: ProviderTokenIssuanceStatus;
}

export type ProviderTokenIssuanceStatus = 'pending' | 'issued' | 'failed' | 'revoked';

export interface ProviderTokenIssuanceRecord {
  issuanceId: string;
}

export interface ProviderTokenRefreshRecord {
  refreshId: string;
}

export type ProviderTokenIssuanceDenyReason =
  | 'collab_session_not_found'
  | 'forbidden'
  | 'grant_revoked'
  | 'grant_expired'
  | 'provider_token_revoked';

export type CollabSessionMode = 'view' | 'edit';

export function collabSessionActorId(sessionId: string): string {
  return `session:${sessionId}`;
}

export async function recordCollabSession(pool: DbExecutor, input: {
  sessionId: string;
  docId: string;
  branchId: string;
  mode: CollabSessionMode;
  clientKind: ProviderTokenClientKind;
  actorType: 'agent' | 'user';
  actorId?: string | null;
  actorGrantId?: string | null;
  refreshTokenHash?: string | null;
  isGuest?: boolean;
  role?: 'view' | 'edit' | null;
  displayName: string;
}): Promise<void> {
  await pool.query(
    `insert into collab_sessions
       (id, doc_id, branch_id, mode, client_kind, actor_type, actor_id, actor_grant_id, refresh_token_hash, is_guest, role, display_name)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      input.sessionId,
      input.docId,
      input.branchId,
      input.mode,
      input.clientKind,
      input.actorType,
      input.actorId ?? null,
      input.actorGrantId ?? null,
      input.refreshTokenHash ?? null,
      input.isGuest ?? false,
      input.role ?? null,
      input.displayName,
    ],
  );
}

export async function markCollabSessionFailed(pool: DbExecutor, sessionId: string): Promise<void> {
  await pool.query(
    `update collab_sessions
        set status = 'failed',
            last_seen_at = now()
      where id = $1`,
    [sessionId],
  );
}

export async function recordProviderTokenRefreshAttempt(pool: DbExecutor, input: {
  sessionId: string;
}): Promise<ProviderTokenRefreshRecord | null> {
  const inserted = await pool.query<{ id: string }>(
    `insert into provider_token_refreshes
       (session_id)
     select id
       from collab_sessions
      where id = $1
     returning id`,
    [input.sessionId],
  );
  const row = inserted.rows[0];
  if (!row) return null;
  return { refreshId: row.id };
}

export async function markProviderTokenRefreshIssued(pool: DbExecutor, input: {
  refreshId: string;
  issuanceId: string;
  expiresAt: string;
}): Promise<void> {
  await pool.query(
    `update provider_token_refreshes
        set issued_at = now(),
            expires_at = $2,
            issuance_id = $3
      where id = $1`,
    [input.refreshId, input.expiresAt, input.issuanceId],
  );
}

export async function markProviderTokenRefreshDenied(pool: DbExecutor, input: {
  refreshId: string;
  denyReason: string;
}): Promise<void> {
  await pool.query(
    `update provider_token_refreshes
        set denied_at = now(),
            deny_reason = $2
      where id = $1`,
    [input.refreshId, input.denyReason],
  );
}

export async function findActiveProviderTokenSession(pool: DbExecutor, input: {
  docId: string;
  branchId: string;
  sessionId: string;
  refreshTokenHash: string;
}): Promise<ActiveProviderTokenSession | null> {
  const found = await pool.query<{
    provider_doc_id: string;
    client_kind: ProviderTokenClientKind;
    actor_type: 'agent' | 'user';
    actor_id: string | null;
    actor_grant_id: string | null;
    is_guest: boolean;
    display_name: string;
    status: ProviderTokenIssuanceStatus;
  }>(
    `select pti.provider_doc_id,
            s.client_kind,
            s.actor_type,
            s.actor_id,
            s.actor_grant_id,
            s.is_guest,
            s.display_name,
            pti.status
       from provider_token_issuances pti
       join collab_sessions s
         on s.id = pti.session_id
        and s.doc_id = pti.doc_id
        and s.branch_id = pti.branch_id
        and s.mode = 'edit'
        and s.role = 'edit'
        and s.status = 'active'
        and s.expires_at > now()
        and s.refresh_token_hash = $4
      where pti.doc_id = $1
        and pti.branch_id = $2
        and pti.session_id = $3
        and pti."authorization" = 'full'
        and pti.status in ('issued', 'revoked')
      order by case when pti.status = 'revoked' then 0 else 1 end,
               pti.issued_at desc,
               pti.id desc
      limit 1`,
    [input.docId, input.branchId, input.sessionId, input.refreshTokenHash],
  );

  const row = found.rows[0];
  if (!row) return null;
  return {
    providerDocId: row.provider_doc_id,
    clientKind: row.client_kind,
    actorType: row.actor_type,
    actorId: row.actor_id,
    actorGrantId: row.actor_grant_id,
    isGuest: row.is_guest,
    displayName: row.display_name,
    status: row.status,
  };
}

export async function countOtherActiveGuestEditSessions(pool: DbExecutor, input: {
  docId: string;
  sessionId: string;
  idleTimeoutSeconds: number;
}): Promise<number> {
  const counted = await pool.query<{ active_guest_sessions: string | number }>(
    `with target_workspace as (
       select coalesce(workspace_id::text, $4 || id::text) as workspace_key
         from documents
        where id = $1
     ), latest_guest_sessions as (
       select s.id as session_id,
              s.last_seen_at,
              latest_issuance.status
         from collab_sessions s
         join documents d on d.id = s.doc_id
         join target_workspace tw on coalesce(d.workspace_id::text, $4 || d.id::text) = tw.workspace_key
         left join lateral (
           select pti.status
             from provider_token_issuances pti
            where pti.doc_id = s.doc_id
              and pti.branch_id = s.branch_id
              and pti.session_id = s.id
              and pti."authorization" = 'full'
              and pti.status in ('pending', 'issued', 'revoked')
            order by pti.issued_at desc,
                     case when pti.status = 'revoked' then 0 else 1 end,
                     pti.id desc
            limit 1
         ) latest_issuance on true
        where s.id <> $2
          and s.mode = 'edit'
          and s.status = 'active'
          and s.is_guest = true
     )
     select count(*) as active_guest_sessions
       from latest_guest_sessions
      where status in ('pending', 'issued')
        and last_seen_at + ($3 * interval '1 second') > now()`,
    [input.docId, input.sessionId, input.idleTimeoutSeconds, LEGACY_DOCUMENT_QUOTA_KEY_PREFIX],
  );

  return Number(counted.rows[0]?.active_guest_sessions ?? 0);
}

export async function readConcurrentGuestEditQuota(pool: DbExecutor, input: {
  docId: string;
  fallbackQuota: number;
}): Promise<number> {
  const result = await pool.query<{ concurrent_guest_edits: string | number | null }>(
    `select case when d.workspace_id is null then $2
                 else coalesce(sl.concurrent_guest_edits, $2)
            end as concurrent_guest_edits
       from documents d
       left join subscriptions s on s.workspace_id = d.workspace_id
        and s.status in ('manual', 'trialing', 'active')
        and (s.current_period_end is null or s.current_period_end > now())
       left join seat_limits sl on d.workspace_id is not null
        and sl.plan_id = coalesce(s.plan_id, 'free')
      where d.id = $1`,
    [input.docId, input.fallbackQuota],
  );
  return Number(result.rows[0]?.concurrent_guest_edits ?? input.fallbackQuota);
}

export async function assertStoredGuestEditGrantActive(pool: DbExecutor, input: {
  docId: string;
  branchId: string;
  grantId: string;
}): Promise<void> {
  const checked = await pool.query<{
    role: 'view' | 'edit';
    revoked_at: Date | string | null;
    expired: boolean | string;
  }>(
    `select g.role,
            g.revoked_at,
            (g.expires_at is not null and g.expires_at <= now()) as expired
       from document_access_grants g
       join document_branches b
         on b.id = $3
        and b.doc_id = g.doc_id
        and b.is_archived = false
      where g.id::text = $1
        and g.doc_id = $2
        and (g.branch_id = $3 or g.branch_id is null)
      limit 1`,
    [input.grantId, input.docId, input.branchId],
  );
  const row = checked.rows[0];
  if (!row) throw new Error('grant_revoked');
  if (row.revoked_at) throw new Error('grant_revoked');
  if (row.expired === true || row.expired === 'true') throw new Error('grant_expired');
  if (row.role !== 'edit') throw new Error('forbidden');
}

async function lockGuestQuotaScope(pool: DbExecutor, docId: string): Promise<void> {
  await pool.query(
     `select pg_advisory_xact_lock(
       hashtext(coalesce(
         (select coalesce(workspace_id::text, $2 || id::text) from documents where id = $1),
         $2 || $1::text
       ))::bigint
     )`,
    [docId, LEGACY_DOCUMENT_QUOTA_KEY_PREFIX],
  );
}

async function touchCollabSessionForTokenIssue(pool: DbExecutor, input: {
  sessionId: string;
  docId: string;
  branchId: string;
  clientKind: ProviderTokenClientKind;
  validForSeconds: number;
}): Promise<void> {
  const touched = await pool.query(
    `update collab_sessions
        set last_seen_at = now(),
            expires_at = now() + ($5 * interval '1 second')
      where id = $1
        and doc_id = $2
        and branch_id = $3
        and mode = 'edit'
        and role = 'edit'
        and status = 'active'
        and (expires_at is null or expires_at > now())
        and client_kind = $4`,
    [input.sessionId, input.docId, input.branchId, input.clientKind, input.validForSeconds],
  );
  if ((touched.rowCount ?? 0) === 0) throw new Error('collab_session_not_found');
}

export async function recordProviderTokenIssuanceWithPolicy(pool: DbPool, input: {
  docId: string;
  branchId: string;
  providerDocId: string;
  sessionId: string;
  clientKind: ProviderTokenClientKind;
  actorType: 'agent' | 'user';
  actorId?: string | null;
  actorGrantId?: string | null;
  authorization: 'full' | 'read-only';
  validForSeconds: number;
  status?: ProviderTokenIssuanceStatus;
  isGuestSession: boolean;
  enforceGuestQuota?: boolean;
  guestQuota: number;
  guestSessionIdleTimeoutSeconds: number;
}): Promise<ProviderTokenIssuanceRecord> {
  return withTransaction(pool, async (client) => {
    const shouldEnforceGuestQuota = input.isGuestSession && (input.enforceGuestQuota ?? true);
    if (shouldEnforceGuestQuota) await lockGuestQuotaScope(client, input.docId);
    await touchCollabSessionForTokenIssue(client, {
      sessionId: input.sessionId,
      docId: input.docId,
      branchId: input.branchId,
      clientKind: input.clientKind,
      validForSeconds: input.validForSeconds,
    });
    if (shouldEnforceGuestQuota) {
      const guestQuota = await readConcurrentGuestEditQuota(client, {
        docId: input.docId,
        fallbackQuota: input.guestQuota,
      });
      const activeGuestSessions = await countOtherActiveGuestEditSessions(client, {
        docId: input.docId,
        sessionId: input.sessionId,
        idleTimeoutSeconds: input.guestSessionIdleTimeoutSeconds,
      });
      if (activeGuestSessions >= guestQuota) throw new Error('guest_session_quota_exceeded');
    }
    return recordProviderTokenIssuance(client, input);
  });
}

export async function recordProviderTokenIssuance(pool: DbExecutor, input: {
  docId: string;
  branchId: string;
  providerDocId: string;
  sessionId: string;
  clientKind: ProviderTokenClientKind;
  actorType: 'agent' | 'user';
  actorId?: string | null;
  actorGrantId?: string | null;
  authorization: 'full' | 'read-only';
  validForSeconds: number;
  status?: ProviderTokenIssuanceStatus;
}): Promise<ProviderTokenIssuanceRecord> {
  // Audit identity comes from validated control-plane session state, never from client-authored Y.PermanentUserData.
  const inserted = await pool.query<{ id: string }>(
    `insert into provider_token_issuances
       (doc_id, branch_id, workspace_id, folder_id, provider_doc_id, session_id, client_kind, actor_type, actor_id, actor_grant_id, "authorization", valid_for_seconds, status)
     select d.id, $2, d.workspace_id, d.folder_id, $3, $4, $5, $6, $7, $8, $9, $10, $11
       from documents d
      where d.id = $1
     returning id`,
    [
      input.docId,
      input.branchId,
      input.providerDocId,
      input.sessionId,
      input.clientKind,
      input.actorType,
      input.actorId ?? null,
      input.actorGrantId ?? null,
      input.authorization,
      input.validForSeconds,
      input.status ?? 'issued',
    ],
  );
  const row = inserted.rows[0];
  if (!row) throw new Error('provider_token_issuance_insert_failed');
  return { issuanceId: row.id };
}

export async function markProviderTokenIssuanceStatus(pool: DbExecutor, input: {
  issuanceId: string;
  status: ProviderTokenIssuanceStatus;
  providerError?: string | null;
}): Promise<void> {
  await pool.query(
    `update provider_token_issuances
        set status = $2,
            provider_error = $3,
            issued_at = case when $2 = 'issued' then now() else issued_at end
      where id = $1`,
    [input.issuanceId, input.status, input.providerError ?? null],
  );
}

const directUserWritePolicySql = `exists (
            select 1
              from documents d
              join document_branches b
                on b.doc_id = d.id
               and b.id = pending.branch_id
               and b.is_archived = false
              left join workspace_members m
                on m.workspace_id = d.workspace_id
               and m.user_id::text = pending.actor_id
             where pending.actor_grant_id is null
               and pending.actor_type = 'user'
               and pending.actor_id is not null
               and pending.actor_id not like 'share:%'
               and pending.actor_id not like 'access:%'
               and pending.actor_id not like 'agent:%'
               and pending.actor_id not in ('admin', 'dev-anonymous')
               and d.id = pending.doc_id
               and (
                 (d.workspace_id is not null and m.role in ('Owner', 'Member'))
                 or (d.workspace_id is null and d.owner_id::text = pending.actor_id)
               )
          )`;

export async function providerTokenIssuanceCanIssue(pool: DbExecutor, input: {
  issuanceId: string;
  docId: string;
  branchId: string;
  sessionId: string;
}): Promise<boolean> {
  const checked = await pool.query(
    `select 1
       from provider_token_issuances pending
      join collab_sessions s
        on s.id = pending.session_id
       and s.doc_id = pending.doc_id
       and s.branch_id = pending.branch_id
       and s.mode = 'edit'
       and s.role = 'edit'
       and s.status = 'active'
       and s.expires_at > now()
      where pending.id = $1
        and pending.status = 'pending'
        and pending.doc_id = $2
        and pending.branch_id = $3
        and pending.session_id = $4
        and not exists (
          select 1
            from provider_token_issuances revoked
           where revoked.doc_id = $2
             and revoked.branch_id = $3
             and revoked.session_id = $4
             and revoked."authorization" = 'full'
             and revoked.status = 'revoked'
        )
        and (
          exists (
            select 1
              from document_access_grants g
             where g.id::text = pending.actor_grant_id
               and g.doc_id = pending.doc_id
               and (g.branch_id = pending.branch_id or g.branch_id is null)
               and g.role = 'edit'
               and g.revoked_at is null
               and (g.expires_at is null or g.expires_at > now())
          )
          or exists (
            select 1
              from agent_tokens t
             where pending.actor_grant_id is null
               and pending.actor_id = 'agent:' || t.token_hash
               and t.doc_id = pending.doc_id
               and (t.branch_id = pending.branch_id or t.branch_id is null)
               and t.can_write = true
               and t.revoked_at is null
               and (t.expires_at is null or t.expires_at > now())
          )
          or ${directUserWritePolicySql}
          or (
            pending.actor_grant_id is null
            and pending.actor_id in ('admin', 'dev-anonymous')
          )
        )
      limit 1`,
    [input.issuanceId, input.docId, input.branchId, input.sessionId],
  );
  return (checked.rowCount ?? 0) > 0;
}

export async function providerTokenIssuanceDenyReason(pool: DbExecutor, input: {
  issuanceId: string;
  docId: string;
  branchId: string;
  sessionId: string;
}): Promise<ProviderTokenIssuanceDenyReason> {
  const checked = await pool.query<{ deny_reason: ProviderTokenIssuanceDenyReason }>(
    `select case
              when pending.id is null then 'collab_session_not_found'
              when not exists (
                select 1
                  from collab_sessions s
                 where s.id = pending.session_id
                   and s.doc_id = pending.doc_id
                   and s.branch_id = pending.branch_id
                   and s.mode = 'edit'
                   and s.role = 'edit'
                   and s.status = 'active'
                   and s.expires_at > now()
              ) then 'collab_session_not_found'
              when exists (
                select 1
                  from provider_token_issuances revoked
                 where revoked.doc_id = $2
                   and revoked.branch_id = $3
                   and revoked.session_id = $4
                   and revoked."authorization" = 'full'
                   and revoked.status = 'revoked'
              ) then 'provider_token_revoked'
              when exists (
                select 1
                  from document_access_grants g
                 where g.id::text = pending.actor_grant_id
                   and g.doc_id = pending.doc_id
                   and (g.branch_id = pending.branch_id or g.branch_id is null)
                   and g.revoked_at is not null
              ) then 'grant_revoked'
              when exists (
                select 1
                  from document_access_grants g
                 where g.id::text = pending.actor_grant_id
                   and g.doc_id = pending.doc_id
                   and (g.branch_id = pending.branch_id or g.branch_id is null)
                   and g.expires_at is not null
                   and g.expires_at <= now()
              ) then 'grant_expired'
              else 'forbidden'
            end as deny_reason
       from (select 1) provider_token_issuance_policy_reason
       left join provider_token_issuances pending
         on pending.id = $1
        and pending.doc_id = $2
        and pending.branch_id = $3
        and pending.session_id = $4
      limit 1`,
    [input.issuanceId, input.docId, input.branchId, input.sessionId],
  );
  return checked.rows[0]?.deny_reason ?? 'collab_session_not_found';
}

export async function markProviderTokenIssuanceIssuedIfSessionActive(pool: DbExecutor, input: {
  issuanceId: string;
  docId: string;
  branchId: string;
  sessionId: string;
}): Promise<boolean> {
  const updated = await pool.query(
    `update provider_token_issuances pending
        set status = 'issued',
            provider_error = null,
            issued_at = now()
      where pending.id = $1
        and pending.status = 'pending'
        and pending.doc_id = $2
        and pending.branch_id = $3
        and pending.session_id = $4
        and exists (
          select 1
            from collab_sessions s
           where s.id = pending.session_id
             and s.doc_id = pending.doc_id
             and s.branch_id = pending.branch_id
             and s.mode = 'edit'
             and s.role = 'edit'
             and s.status = 'active'
             and s.expires_at > now()
        )
        and not exists (
          select 1
            from provider_token_issuances revoked
           where revoked.doc_id = $2
             and revoked.branch_id = $3
             and revoked.session_id = $4
             and revoked."authorization" = 'full'
             and revoked.status = 'revoked'
        )
        and (
          exists (
            select 1
              from document_access_grants g
             where g.id::text = pending.actor_grant_id
               and g.doc_id = pending.doc_id
               and (g.branch_id = pending.branch_id or g.branch_id is null)
               and g.role = 'edit'
               and g.revoked_at is null
               and (g.expires_at is null or g.expires_at > now())
          )
          or exists (
            select 1
              from agent_tokens t
             where pending.actor_grant_id is null
               and pending.actor_id = 'agent:' || t.token_hash
               and t.doc_id = pending.doc_id
               and (t.branch_id = pending.branch_id or t.branch_id is null)
               and t.can_write = true
               and t.revoked_at is null
               and (t.expires_at is null or t.expires_at > now())
          )
          or ${directUserWritePolicySql}
          or (
            pending.actor_grant_id is null
            and pending.actor_id in ('admin', 'dev-anonymous')
          )
        )`,
    [input.issuanceId, input.docId, input.branchId, input.sessionId],
  );
  return (updated.rowCount ?? 0) > 0;
}
