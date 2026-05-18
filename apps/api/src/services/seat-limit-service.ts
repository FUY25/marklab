import type { DbExecutor } from '../db/client';

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

export async function readWorkspaceMemberSeatLimit(pool: DbExecutor, input: {
  workspaceId: string;
  fallbackLimit: number;
}): Promise<number> {
  const result = await pool.query<{ member_seats: string | number | null }>(
    `select coalesce(sl.member_seats, $2) as member_seats
       from workspaces w
       left join subscriptions s on s.workspace_id = w.id
        and s.status in ('manual', 'trialing', 'active')
        and (s.current_period_end is null or s.current_period_end > now())
       left join seat_limits sl on sl.plan_id = coalesce(s.plan_id, 'free')
      where w.id = $1`,
    [input.workspaceId, input.fallbackLimit],
  );
  return Number(result.rows[0]?.member_seats ?? input.fallbackLimit);
}
