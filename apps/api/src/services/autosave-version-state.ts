import type { DbExecutor } from '../db/client';

export interface AutosaveObservation {
  pendingHash: string | null;
  activeStartedAt: Date | null;
  pendingFirstSeenAt: Date | null;
}

export async function readAutosaveObservation(client: DbExecutor, branchId: string): Promise<AutosaveObservation> {
  const result = await client.query<{
    pending_hash: string | null;
    active_started_at: Date | string | null;
    pending_first_seen_at: Date | string | null;
  }>(
    `select pending_hash, active_started_at, pending_first_seen_at
       from document_branch_autosave_state
      where branch_id = $1
      for update`,
    [branchId],
  );
  const row = result.rows[0];
  return {
    pendingHash: row?.pending_hash ?? null,
    activeStartedAt: row?.active_started_at ? new Date(row.active_started_at) : null,
    pendingFirstSeenAt: row?.pending_first_seen_at ? new Date(row.pending_first_seen_at) : null,
  };
}

export async function recordAutosaveObservation(
  client: DbExecutor,
  branchId: string,
  pendingHash: string,
  activeStartedAt: Date,
  firstSeenAt: Date,
  lastSeenAt: Date,
): Promise<void> {
  await client.query(
    `insert into document_branch_autosave_state
       (branch_id, pending_hash, active_started_at, pending_first_seen_at, pending_last_seen_at)
     values ($1, $2, $3, $4, $5)
     on conflict (branch_id) do update
       set pending_hash = excluded.pending_hash,
           active_started_at = coalesce(document_branch_autosave_state.active_started_at, excluded.active_started_at),
           pending_first_seen_at = excluded.pending_first_seen_at,
           pending_last_seen_at = excluded.pending_last_seen_at,
           updated_at = now()`,
    [branchId, pendingHash, activeStartedAt, firstSeenAt, lastSeenAt],
  );
}

export async function clearAutosaveObservation(client: DbExecutor, branchId: string): Promise<void> {
  await client.query(
    `delete from document_branch_autosave_state
      where branch_id = $1`,
    [branchId],
  );
}

export async function pruneOldAutosaveVersions(client: DbExecutor, branchId: string): Promise<void> {
  const clock = await client.query<{ branch_edit_clock: Date | string | null }>(
    `select max(created_at) as branch_edit_clock
       from document_versions
      where branch_id = $1`,
    [branchId],
  );
  const branchEditClock = clock.rows[0]?.branch_edit_clock;
  if (!branchEditClock) return;

  const prunable = await client.query<{ id: string }>(
    `select id
       from document_versions
      where branch_id = $1
        and operation = 'autosave'
        and created_at < (($2::timestamptz) - ($3::interval))
        and id <> coalesce((select head_version_id from document_branches where id = $1), '00000000-0000-0000-0000-000000000000'::uuid)`,
    [branchId, branchEditClock, '30 days'],
  );
  const ids = prunable.rows.map((row) => row.id);
  if (ids.length === 0) return;

  await client.query(
    `update document_versions
        set parent_version_id = null
      where parent_version_id = any($1::uuid[])`,
    [ids],
  );
  await client.query(
    `update document_branches
        set created_from_version_id = null
      where created_from_version_id = any($1::uuid[])`,
    [ids],
  );
  await client.query(
    `delete from document_versions
      where id = any($1::uuid[])
        and operation = 'autosave'`,
    [ids],
  );
}
