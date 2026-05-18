import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { DbPool, DbQueryResult, DbTransactionClient } from '../db/client';
import { createHttpApp } from '../http/app';
import { hashToken } from '../services/access-control';
import { createUnavailableLiveMarkdownWriter } from '../services/live-writer';

function createBillingRoutePool() {
  const sessions = new Map([[hashToken('owner-token'), 'user_owner']]);
  const query: DbPool['query'] = async <Row = unknown>(sql: string, params?: readonly unknown[]): Promise<DbQueryResult<Row>> => {
    if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return { rows: [], rowCount: 0 };
    if (sql.includes('update user_sessions') && sql.includes('from users')) {
      const userId = sessions.get(String(params?.[0]));
      if (!userId) return { rows: [], rowCount: 0 };
      return {
        rows: [{ session_id: 'session_1', id: userId, email: 'owner@example.test', display_name: 'Owner' } as Row],
        rowCount: 1,
      };
    }
    if (sql.includes('from workspace_members') && sql.includes('where workspace_id = $1')) {
      return { rows: [{ role: 'Owner' } as Row], rowCount: 1 };
    }
    if (sql.includes('from subscriptions s') && sql.includes('join seat_limits sl')) {
      return {
        rows: [{
          plan_id: 'free',
          plan_name: 'Free',
          status: 'manual',
          billing_mode: 'manual',
          current_period_end: null,
          member_seats: 1,
          concurrent_guest_edits: 3,
          member_seats_used: 1,
          guest_edit_sessions_used: 0,
        } as Row],
        rowCount: 1,
      };
    }
    throw new Error(`unexpected_query:${sql}`);
  };
  return {
    query,
    async connect(): Promise<DbTransactionClient> {
      return { query, release: () => undefined };
    },
  };
}

describe('billing routes', () => {
  it('returns current manual/free billing state for a logged-in workspace owner', async () => {
    const app = createHttpApp(createBillingRoutePool(), createUnavailableLiveMarkdownWriter());

    const response = await request(app)
      .get('/api/workspaces/ws_1/billing')
      .set({ Authorization: 'Bearer owner-token' })
      .expect(200);

    expect(response.body.billing).toMatchObject({
      workspaceId: 'ws_1',
      role: 'Owner',
      mode: 'manual',
      plan: {
        planId: 'free',
        status: 'manual',
      },
      limits: {
        memberSeats: 1,
        concurrentGuestEdits: 3,
      },
      management: {
        stripeConfigured: false,
        canManagePayment: false,
      },
    });
  });
});
