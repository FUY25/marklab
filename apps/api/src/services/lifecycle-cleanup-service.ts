import { rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { DbPool } from '../db/client';

export const DATA_LIFECYCLE_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
export const DEFAULT_DATA_LIFECYCLE_CLEANUP_LIMIT = 100;
export const DEFAULT_PROVIDER_DOC_DELETION_GRACE_MS = 15 * 60 * 1000;
const dayMs = 24 * 60 * 60 * 1000;

export interface DataLifecycleCleanupPolicy {
  oidcStateRetentionDays: number;
  userSessionRetentionDays: number;
  accessGrantRetentionDays: number;
  accessSessionRetentionDays: number;
  collabSessionRetentionDays: number;
  providerTokenAuditRetentionDays: number;
}

export const DEFAULT_DATA_LIFECYCLE_CLEANUP_POLICY: DataLifecycleCleanupPolicy = {
  oidcStateRetentionDays: 1,
  userSessionRetentionDays: 90,
  accessGrantRetentionDays: 90,
  accessSessionRetentionDays: 90,
  collabSessionRetentionDays: 90,
  providerTokenAuditRetentionDays: 90,
};

export interface DataLifecycleCleanupInput {
  pool: DbPool;
  now?: Date;
  providerStorePath?: string | undefined;
  providerDocDeletionGraceMs?: number;
  limit?: number;
  policy?: Partial<DataLifecycleCleanupPolicy>;
}

export interface DataLifecycleCleanupResult {
  rowsDeleted: number;
  providerDocs: {
    checked: number;
    completed: number;
    failed: number;
    skipped: number;
  };
}

export interface DataLifecycleCleanupJob {
  runNow(): Promise<DataLifecycleCleanupResult | null>;
  stop(): void;
}

interface ProviderDocDeletionRow {
  id: string;
  provider_doc_id: string;
}

interface StartDataLifecycleCleanupJobInput extends DataLifecycleCleanupInput {
  intervalMs?: number;
  cleanup?: (input: DataLifecycleCleanupInput) => Promise<DataLifecycleCleanupResult>;
  onError?: (error: unknown) => void;
}

function cutoff(now: Date, retentionDays: number): Date {
  return new Date(now.getTime() - retentionDays * dayMs);
}

function rowCount(value: number | null | undefined): number {
  return value ?? 0;
}

async function deleteOldRows(pool: DbPool, sql: string, params: readonly unknown[]): Promise<number> {
  const result = await pool.query(sql, params);
  return rowCount(result.rowCount);
}

function providerDocDirectory(input: { providerStorePath?: string | undefined; providerDocId: string }): string {
  if (!input.providerStorePath) throw new Error('provider_store_path_unavailable');
  if (input.providerStorePath.startsWith('s3://')) throw new Error('provider_store_not_local');
  if (
    input.providerDocId === '.' ||
    input.providerDocId === '..' ||
    input.providerDocId.includes('/') ||
    input.providerDocId.includes('\\')
  ) {
    throw new Error('provider_doc_id_not_direct_child');
  }
  const storeRoot = resolve(input.providerStorePath);
  const target = resolve(storeRoot, input.providerDocId);
  if (dirname(target) !== storeRoot) throw new Error('provider_doc_id_not_direct_child');
  return target;
}

async function providerDocIsStillReferenced(pool: DbPool, providerDocId: string): Promise<boolean> {
  const result = await pool.query(
    `select 1
       from document_branch_states
      where provider_doc_id = $1
      limit 1`,
    [providerDocId],
  );
  return rowCount(result.rowCount) > 0 || result.rows.length > 0;
}

async function markProviderDocCleanup(input: {
  pool: DbPool;
  id: string;
  status: 'complete' | 'failed';
  now: Date;
  error?: string | undefined;
}): Promise<void> {
  await input.pool.query(
    `update provider_doc_deletions
        set cleanup_status = $2,
            cleanup_attempted_at = $3,
            cleanup_completed_at = case when $2 = 'complete' then $3 else cleanup_completed_at end,
            cleanup_error = $4
      where id = $1`,
    [input.id, input.status, input.now, input.error ?? null],
  );
}

async function cleanupProviderDocDeletions(input: {
  pool: DbPool;
  now: Date;
  providerStorePath?: string | undefined;
  graceMs: number;
  limit: number;
}): Promise<DataLifecycleCleanupResult['providerDocs']> {
  const result: DataLifecycleCleanupResult['providerDocs'] = {
    checked: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
  };
  const dueBefore = new Date(input.now.getTime() - input.graceMs);
  const rows = await input.pool.query<ProviderDocDeletionRow>(
    `select id, provider_doc_id
       from provider_doc_deletions
      where cleanup_status in ('pending', 'failed')
        and created_at <= $1
      order by created_at asc
      limit $2`,
    [dueBefore, input.limit],
  );

  for (const row of rows.rows) {
    result.checked += 1;
    try {
      if (await providerDocIsStillReferenced(input.pool, row.provider_doc_id)) {
        throw new Error('provider_doc_still_referenced');
      }
      const target = providerDocDirectory({
        providerStorePath: input.providerStorePath,
        providerDocId: row.provider_doc_id,
      });
      await rm(target, { recursive: true, force: true });
      await markProviderDocCleanup({ pool: input.pool, id: row.id, status: 'complete', now: input.now });
      result.completed += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'provider_doc_cleanup_failed';
      await markProviderDocCleanup({
        pool: input.pool,
        id: row.id,
        status: 'failed',
        now: input.now,
        error: message,
      });
      result.failed += 1;
    }
  }

  return result;
}

export async function cleanupDataLifecycle(input: DataLifecycleCleanupInput): Promise<DataLifecycleCleanupResult> {
  const now = input.now ?? new Date();
  const policy = { ...DEFAULT_DATA_LIFECYCLE_CLEANUP_POLICY, ...(input.policy ?? {}) };
  let rowsDeleted = 0;

  rowsDeleted += await deleteOldRows(input.pool, `
    delete from oidc_login_states
     where expires_at < $1
        or (used_at is not null and used_at < $1)
  `, [cutoff(now, policy.oidcStateRetentionDays)]);

  rowsDeleted += await deleteOldRows(input.pool, `
    delete from user_sessions
     where expires_at < $1
        or (revoked_at is not null and revoked_at < $1)
  `, [cutoff(now, policy.userSessionRetentionDays)]);

  rowsDeleted += await deleteOldRows(input.pool, `
    delete from workspace_share_keys
     where (expires_at is not null and expires_at < $1)
        or (revoked_at is not null and revoked_at < $1)
  `, [cutoff(now, policy.accessGrantRetentionDays)]);

  rowsDeleted += await deleteOldRows(input.pool, `
    delete from document_access_grants
     where (expires_at is not null and expires_at < $1)
        or (revoked_at is not null and revoked_at < $1)
  `, [cutoff(now, policy.accessGrantRetentionDays)]);

  rowsDeleted += await deleteOldRows(input.pool, `
    delete from share_links
     where (expires_at is not null and expires_at < $1)
        or (revoked_at is not null and revoked_at < $1)
  `, [cutoff(now, policy.accessGrantRetentionDays)]);

  rowsDeleted += await deleteOldRows(input.pool, `
    delete from agent_tokens
     where (expires_at is not null and expires_at < $1)
        or (revoked_at is not null and revoked_at < $1)
  `, [cutoff(now, policy.accessGrantRetentionDays)]);

  rowsDeleted += await deleteOldRows(input.pool, `
    delete from document_access_sessions
     where last_seen_at < $1
  `, [cutoff(now, policy.accessSessionRetentionDays)]);

  const providerTokenAuditCutoff = cutoff(now, policy.providerTokenAuditRetentionDays);
  rowsDeleted += await deleteOldRows(input.pool, `
    delete from provider_token_refreshes
     where coalesce(denied_at, expires_at, issued_at, created_at) < $1
  `, [providerTokenAuditCutoff]);

  rowsDeleted += await deleteOldRows(input.pool, `
    delete from provider_token_issuances
     where (status in ('failed', 'revoked') and issued_at < $1)
        or (issued_at + (valid_for_seconds * interval '1 second') < $1)
  `, [providerTokenAuditCutoff]);

  rowsDeleted += await deleteOldRows(input.pool, `
    delete from collab_sessions s
     where (s.status in ('failed', 'closed') or s.expires_at < $1)
       and coalesce(s.expires_at, s.last_seen_at, s.created_at) < $1
       and not exists (
         select 1
           from provider_token_issuances i
          where i.session_id = s.id
       )
       and not exists (
         select 1
           from provider_token_refreshes r
          where r.session_id = s.id
       )
  `, [cutoff(now, policy.collabSessionRetentionDays)]);

  const providerDocs = await cleanupProviderDocDeletions({
    pool: input.pool,
    now,
    ...(input.providerStorePath ? { providerStorePath: input.providerStorePath } : {}),
    graceMs: input.providerDocDeletionGraceMs ?? DEFAULT_PROVIDER_DOC_DELETION_GRACE_MS,
    limit: input.limit ?? DEFAULT_DATA_LIFECYCLE_CLEANUP_LIMIT,
  });

  return { rowsDeleted, providerDocs };
}

export function startDataLifecycleCleanupJob(input: StartDataLifecycleCleanupJobInput): DataLifecycleCleanupJob {
  let running = false;
  let stopped = false;
  const intervalMs = input.intervalMs ?? DATA_LIFECYCLE_CLEANUP_INTERVAL_MS;
  const cleanup = input.cleanup ?? cleanupDataLifecycle;

  const runNow = async (): Promise<DataLifecycleCleanupResult | null> => {
    if (running || stopped) return null;
    running = true;
    try {
      return await cleanup(input);
    } catch (error) {
      input.onError?.(error);
      throw error;
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void runNow().catch((error) => input.onError?.(error));
  }, intervalMs);
  timer.unref?.();

  return {
    runNow,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
