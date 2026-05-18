import { afterEach, describe, expect, it } from 'vitest';
import type { DbExecutor, DbQueryResult } from '../db/client';
import { getWorkspaceBillingState } from './billing-service';

function createBillingPool(input: { role?: 'Owner' | 'Member' | 'Reader'; subscription?: Record<string, unknown>; queries?: string[] } = {}): DbExecutor {
  const role = input.role ?? 'Owner';
  const queries = input.queries ?? [];
  const subscription = input.subscription ?? {
    plan_id: 'free',
    plan_name: 'Free',
    status: 'manual',
    billing_mode: 'manual',
    current_period_end: null,
    member_seats: 1,
    concurrent_guest_edits: 3,
    member_seats_used: 1,
    guest_edit_sessions_used: 2,
  };

  return {
    async query<Row = unknown>(sql: string): Promise<DbQueryResult<Row>> {
      queries.push(sql);
      if (sql.includes('from workspace_members') && sql.includes('where workspace_id = $1')) {
        return { rows: [{ role } as Row], rowCount: 1 };
      }
      if (sql.includes('from subscriptions s') && sql.includes('join seat_limits sl')) {
        return { rows: [subscription as Row], rowCount: 1 };
      }
      throw new Error(`unexpected_query:${sql}`);
    },
  };
}

describe('billing service', () => {
  const originalStripeSecret = process.env.MARKLAB_STRIPE_SECRET_KEY;

  afterEach(() => {
    if (originalStripeSecret === undefined) delete process.env.MARKLAB_STRIPE_SECRET_KEY;
    else process.env.MARKLAB_STRIPE_SECRET_KEY = originalStripeSecret;
  });

  it('returns deterministic manual/free limits and current usage for a workspace owner', async () => {
    await expect(
      getWorkspaceBillingState(createBillingPool(), { workspaceId: 'ws_1', userId: 'user_owner' }),
    ).resolves.toEqual({
      workspaceId: 'ws_1',
      role: 'Owner',
      canManagePlan: false,
      mode: 'manual',
      plan: {
        planId: 'free',
        name: 'Free',
        status: 'manual',
        currentPeriodEnd: null,
      },
      limits: {
        memberSeats: 1,
        concurrentGuestEdits: 3,
      },
      usage: {
        memberSeats: 1,
        concurrentGuestEdits: 2,
      },
      management: {
        stripeConfigured: false,
        canManagePayment: false,
        message: 'Manual/free alpha mode. Stripe and paid-plan changes are not enabled.',
      },
    });
  });

  it('keeps the billing tab read-only for non-owner workspace members', async () => {
    const state = await getWorkspaceBillingState(createBillingPool({ role: 'Member' }), {
      workspaceId: 'ws_1',
      userId: 'user_member',
    });

    expect(state.role).toBe('Member');
    expect(state.canManagePlan).toBe(false);
    expect(state.management.canManagePayment).toBe(false);
  });

  it('does not expose billing state to read-only workspace members', async () => {
    await expect(
      getWorkspaceBillingState(createBillingPool({ role: 'Reader' }), {
        workspaceId: 'ws_1',
        userId: 'user_reader',
      }),
    ).rejects.toThrow('forbidden');
  });

  it('uses the same active subscription and guest edit usage predicates as quota enforcement', async () => {
    const queries: string[] = [];
    await getWorkspaceBillingState(createBillingPool({ queries }), { workspaceId: 'ws_1', userId: 'user_owner' });
    const billingQuery = queries.find((sql) => sql.includes('with selected_subscription')) ?? '';

    expect(billingQuery).toContain("s.status in ('manual', 'trialing', 'active')");
    expect(billingQuery).toContain('s.current_period_end is null or s.current_period_end > now()');
    expect(billingQuery).toContain('left join lateral');
    expect(billingQuery).toContain("pti.status in ('pending', 'issued', 'revoked')");
    expect(billingQuery).toContain("where active_guest_sessions.status in ('pending', 'issued')");
    expect(billingQuery).toContain("active_guest_sessions.last_seen_at + ($2 * interval '1 second') > now()");
  });

  it('only reports Stripe configured when a non-empty secret exists', async () => {
    delete process.env.MARKLAB_STRIPE_SECRET_KEY;
    const missingSecret = await getWorkspaceBillingState(createBillingPool({
      subscription: {
        plan_id: 'team',
        plan_name: 'Team',
        status: 'active',
        billing_mode: 'stripe',
        current_period_end: null,
        member_seats: 10,
        concurrent_guest_edits: 10,
        member_seats_used: 2,
        guest_edit_sessions_used: 1,
      },
    }), { workspaceId: 'ws_1', userId: 'user_owner' });
    expect(missingSecret.management.stripeConfigured).toBe(false);

    process.env.MARKLAB_STRIPE_SECRET_KEY = 'sk_test_configured';
    const configured = await getWorkspaceBillingState(createBillingPool({
      subscription: {
        plan_id: 'team',
        plan_name: 'Team',
        status: 'active',
        billing_mode: 'stripe',
        current_period_end: null,
        member_seats: 10,
        concurrent_guest_edits: 10,
        member_seats_used: 2,
        guest_edit_sessions_used: 1,
      },
    }), { workspaceId: 'ws_1', userId: 'user_owner' });
    expect(configured.management.stripeConfigured).toBe(true);
  });
});
