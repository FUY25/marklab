import { describe, expect, it } from 'vitest';
import type { DbExecutor, DbQueryResult } from '../db/client';
import {
  readConcurrentGuestEditQuota,
  readWorkspaceMemberSeatLimit,
} from './seat-limit-service';

describe('seat limit service', () => {
  it('uses the workspace plan concurrent guest quota for workspace-owned documents', async () => {
    let capturedSql = '';
    let capturedParams: readonly unknown[] = [];
    const pool: DbExecutor = {
      async query<Row = unknown>(sql: string, params: readonly unknown[] = []): Promise<DbQueryResult<Row>> {
        capturedSql = sql;
        capturedParams = params;
        return { rows: [{ concurrent_guest_edits: '5' } as Row], rowCount: 1 };
      },
    };

    await expect(readConcurrentGuestEditQuota(pool, {
      docId: 'doc_1',
      fallbackQuota: 3,
    })).resolves.toBe(5);

    expect(capturedParams).toEqual(['doc_1', 3]);
    expect(capturedSql).toContain("s.status in ('manual', 'trialing', 'active')");
    expect(capturedSql).toContain('seat_limits sl');
    expect(capturedSql).toContain('case when d.workspace_id is null then $2');
  });

  it('uses the legacy fallback quota for documents without a workspace', async () => {
    const pool: DbExecutor = {
      async query<Row = unknown>(): Promise<DbQueryResult<Row>> {
        return { rows: [{ concurrent_guest_edits: '7' } as Row], rowCount: 1 };
      },
    };

    await expect(readConcurrentGuestEditQuota(pool, {
      docId: 'legacy_doc',
      fallbackQuota: 7,
    })).resolves.toBe(7);
  });

  it('uses the active workspace subscription member-seat limit', async () => {
    let capturedSql = '';
    let capturedParams: readonly unknown[] = [];
    const pool: DbExecutor = {
      async query<Row = unknown>(sql: string, params: readonly unknown[] = []): Promise<DbQueryResult<Row>> {
        capturedSql = sql;
        capturedParams = params;
        return { rows: [{ member_seats: '4' } as Row], rowCount: 1 };
      },
    };

    await expect(readWorkspaceMemberSeatLimit(pool, {
      workspaceId: 'ws_1',
      fallbackLimit: 1,
    })).resolves.toBe(4);

    expect(capturedParams).toEqual(['ws_1', 1]);
    expect(capturedSql).toContain("s.status in ('manual', 'trialing', 'active')");
    expect(capturedSql).toContain('seat_limits sl');
    expect(capturedSql).toContain("coalesce(sl.member_seats, $2)");
  });
});
