import type { DbExecutor } from '../db/client';
import { requireWorkspaceRole, type WorkspaceRole } from './control-plane-access';

export type BillingMode = 'manual' | 'stripe';

export interface WorkspaceBillingState {
  workspaceId: string;
  role: WorkspaceRole;
  canManagePlan: boolean;
  mode: BillingMode;
  plan: {
    planId: string;
    name: string;
    status: string;
    currentPeriodEnd: string | null;
  };
  limits: {
    memberSeats: number;
    concurrentGuestEdits: number;
  };
  usage: {
    memberSeats: number;
    concurrentGuestEdits: number;
  };
  management: {
    stripeConfigured: boolean;
    canManagePayment: boolean;
    message: string;
  };
}

interface BillingStateRow {
  plan_id: string;
  plan_name: string;
  status: string;
  billing_mode: BillingMode | null;
  current_period_end: Date | string | null;
  member_seats: string | number;
  concurrent_guest_edits: string | number;
  member_seats_used: string | number;
  guest_edit_sessions_used: string | number;
}

function toIsoString(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export async function getWorkspaceBillingState(pool: DbExecutor, input: {
  workspaceId: string;
  userId: string;
}): Promise<WorkspaceBillingState> {
  const role = await requireWorkspaceRole(pool, {
    workspaceId: input.workspaceId,
    userId: input.userId,
    allowed: ['Owner', 'Member', 'Reader'],
  });

  const result = await pool.query<BillingStateRow>(
    `with selected_subscription as (
        select *
          from subscriptions s
         where s.workspace_id = $1
         limit 1
      )
      select coalesce(s.plan_id, 'free') as plan_id,
            p.name as plan_name,
            coalesce(s.status, 'manual') as status,
            coalesce(s.billing_mode, 'manual') as billing_mode,
            s.current_period_end,
            sl.member_seats,
            sl.concurrent_guest_edits,
            (
              select count(*)
                from workspace_members wm
               where wm.workspace_id = $1
            ) as member_seats_used,
            (
              select count(*)
                from collab_sessions cs
                join documents d on d.id = cs.doc_id
               where d.workspace_id = $1
                 and cs.mode = 'edit'
                 and cs.is_guest = true
                 and cs.status = 'active'
                 and (cs.expires_at is null or cs.expires_at > now())
            ) as guest_edit_sessions_used
       from (select 1) seed
       left join selected_subscription s on true
       join plans p on p.id = coalesce(s.plan_id, 'free')
       join seat_limits sl on sl.plan_id = p.id
      limit 1`,
    [input.workspaceId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('workspace_billing_not_found');
  const mode = row.billing_mode ?? 'manual';
  const stripeConfigured = mode === 'stripe' && Boolean(process.env.MARKLAB_STRIPE_SECRET_KEY?.trim());
  return {
    workspaceId: input.workspaceId,
    role,
    canManagePlan: false,
    mode,
    plan: {
      planId: row.plan_id,
      name: row.plan_name,
      status: row.status,
      currentPeriodEnd: toIsoString(row.current_period_end),
    },
    limits: {
      memberSeats: Number(row.member_seats),
      concurrentGuestEdits: Number(row.concurrent_guest_edits),
    },
    usage: {
      memberSeats: Number(row.member_seats_used),
      concurrentGuestEdits: Number(row.guest_edit_sessions_used),
    },
    management: {
      stripeConfigured,
      canManagePayment: false,
      message: 'Manual/free alpha mode. Stripe and paid-plan changes are not enabled.',
    },
  };
}
