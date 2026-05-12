import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { DbQueryResult } from '../db/client';
import {
  countOtherActiveGuestEditSessions,
  ensureProviderDocId,
  findActiveProviderTokenSession,
  LEGACY_DOCUMENT_QUOTA_KEY_PREFIX,
  markProviderDocSeeded,
  markProviderTokenIssuanceIssuedIfSessionActive,
  markProviderTokenRefreshIssued,
  providerTokenIssuanceCanIssue,
  recordProviderTokenIssuanceWithPolicy,
  readConcurrentGuestEditQuota,
} from './provider-doc-service';

function createProviderDocPool(existingProviderDocId: string | null = null, seededAt: string | null = '2026-05-11T00:00:00.000Z') {
  const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  const yjsState = new Uint8Array([1, 2, 3]);
  return {
    calls,
    async query<Row = unknown>(sql: string, params: readonly unknown[] = []): Promise<DbQueryResult<Row>> {
      calls.push({ sql, params });
      if (/select .*provider_doc_id/us.test(sql)) {
        return {
          rows: (existingProviderDocId
            ? [{ provider_doc_id: existingProviderDocId, provider_doc_seeded_at: seededAt, yjs_state: yjsState }]
            : [{ provider_doc_id: null, provider_doc_seeded_at: null, yjs_state: yjsState }]) as Row[],
        };
      }
      if (/update document_branch_states[\s\S]+provider_doc_seeded_at = now/u.test(sql)) {
        return { rows: [], rowCount: 1 };
      }
      if (/update document_branch_states/u.test(sql)) {
        return { rows: [{ provider_doc_id: params[2], provider_doc_seeded_at: null, yjs_state: yjsState }] as Row[] };
      }
      throw new Error(`unexpected_query:${sql}`);
    },
  };
}

describe('ensureProviderDocId', () => {
  it('reuses an existing opaque provider document id', async () => {
    const pool = createProviderDocPool('ml_doc_existing');
    await expect(ensureProviderDocId(pool, { docId: 'doc_1', branchId: 'branch_1' })).resolves.toMatchObject({
      providerDocId: 'ml_doc_existing',
      created: false,
      needsSeed: false,
    });
    expect(pool.calls[0]?.params).toEqual(['branch_1', 'doc_1']);
    expect(pool.calls[0]?.sql).toContain('join document_branches');
    expect(pool.calls).toHaveLength(1);
  });

  it('requires seeding again when a provider document id exists without a seed marker', async () => {
    const pool = createProviderDocPool('ml_doc_existing', null);
    await expect(ensureProviderDocId(pool, { docId: 'doc_1', branchId: 'branch_1' })).resolves.toMatchObject({
      providerDocId: 'ml_doc_existing',
      created: false,
      needsSeed: true,
    });
  });

  it('creates an opaque provider document id when the branch state has none', async () => {
    const pool = createProviderDocPool(null);
    const providerDoc = await ensureProviderDocId(pool, { docId: 'doc_1', branchId: 'branch_1' });
    expect(providerDoc.providerDocId).toMatch(/^ml_doc_[0-9a-f-]{36}$/u);
    expect(providerDoc.created).toBe(true);
    expect(providerDoc.needsSeed).toBe(true);
    expect(providerDoc.initialYjsState).toEqual(new Uint8Array([1, 2, 3]));
    expect(pool.calls[1]?.params?.slice(0, 2)).toEqual(['branch_1', 'doc_1']);
    expect(pool.calls).toHaveLength(2);
  });

  it('marks a provider document seeded only for the requested branch document pair', async () => {
    const pool = createProviderDocPool('ml_doc_existing');

    await markProviderDocSeeded(pool, {
      docId: 'doc_1',
      branchId: 'branch_1',
      providerDocId: 'ml_doc_existing',
      seededYjsState: new Uint8Array([1, 2, 3]),
    });

    expect(pool.calls[0]?.params).toEqual(['branch_1', 'doc_1', 'ml_doc_existing', Buffer.from([1, 2, 3])]);
    expect(pool.calls[0]?.sql).toContain('provider_doc_seeded_at = now()');
    expect(pool.calls[0]?.sql).toContain('s.provider_doc_id = $3');
    expect(pool.calls[0]?.sql).toContain('s.yjs_state = $4');
  });

  it('does not mark a provider document seeded after the branch state changed', async () => {
    const pool = {
      async query<Row = unknown>(): Promise<DbQueryResult<Row>> {
        return { rows: [], rowCount: 0 };
      },
    };

    await expect(markProviderDocSeeded(pool, {
      docId: 'doc_1',
      branchId: 'branch_1',
      providerDocId: 'ml_doc_existing',
      seededYjsState: new Uint8Array([1, 2, 3]),
    })).rejects.toThrow('provider_doc_seed_stale');
  });
});

describe('findActiveProviderTokenSession', () => {
  it('stores actor grant identifiers as text so non-uuid auth adapters do not break token minting', async () => {
    const schema = await readFile(resolve('apps/api/src/db/schema.sql'), 'utf8');

    expect(schema).toContain('actor_grant_id text');
    expect(schema).toContain('alter column actor_grant_id type text using actor_grant_id::text');
    expect(schema).toContain('provider_doc_seeded_at timestamptz');
    expect(schema).not.toContain('set provider_doc_seeded_at = updated_at');
    expect(schema).toContain('is_guest boolean not null default false');
  });

  it('finds an issued session by identity without requiring the last provider token to still be unexpired', async () => {
    let capturedSql = '';
    const pool = {
      async query<Row = unknown>(sql: string): Promise<DbQueryResult<Row>> {
        capturedSql = sql;
        return {
          rows: [{
            provider_doc_id: 'provider_1',
            client_kind: 'browser',
            actor_type: 'user',
            actor_id: 'user_1',
            actor_grant_id: null,
            is_guest: false,
            display_name: 'Alice',
            status: 'issued',
          } as Row],
          rowCount: 1,
        };
      },
    };

    await expect(findActiveProviderTokenSession(pool, {
      docId: 'doc_1',
      branchId: 'branch_1',
      sessionId: 'session_1',
      refreshTokenHash: 'sha256:refresh',
    })).resolves.toMatchObject({
      providerDocId: 'provider_1',
      actorId: 'user_1',
    });
    expect(capturedSql).toContain("pti.status in ('issued', 'revoked')");
    expect(capturedSql).toContain('join collab_sessions');
    expect(capturedSql).toContain("s.mode = 'edit'");
    expect(capturedSql).toContain("s.status = 'active'");
    expect(capturedSql).toContain('s.refresh_token_hash = $4');
    expect(capturedSql).toContain('s.client_kind');
    expect(capturedSql).toContain('s.actor_id');
    expect(capturedSql).toContain('s.actor_grant_id');
    expect(capturedSql).toContain('pti.status');
    expect(capturedSql).toContain("case when pti.status = 'revoked' then 0 else 1 end");
    expect(capturedSql).not.toContain('valid_for_seconds');
  });

  it('returns a revoked session as revoked so refresh denial can be audited explicitly', async () => {
    const pool = {
      async query<Row = unknown>(): Promise<DbQueryResult<Row>> {
        return {
          rows: [{
            provider_doc_id: 'provider_1',
            client_kind: 'guest',
            actor_type: 'user',
            actor_id: null,
            actor_grant_id: 'grant_1',
            is_guest: true,
            display_name: 'Guest',
            status: 'revoked',
          } as Row],
          rowCount: 1,
        };
      },
    };

    await expect(findActiveProviderTokenSession(pool, {
      docId: 'doc_1',
      branchId: 'branch_1',
      sessionId: 'session_1',
      refreshTokenHash: 'sha256:refresh',
    })).resolves.toMatchObject({ status: 'revoked' });
  });

  it('counts active guest edit sessions excluding the current session id', async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const pool = {
      async query<Row = unknown>(sql: string, params: readonly unknown[] = []): Promise<DbQueryResult<Row>> {
        calls.push({ sql, params });
        return { rows: [{ active_guest_sessions: '2' } as Row], rowCount: 1 };
      },
    };

    await expect(countOtherActiveGuestEditSessions(pool, {
      docId: 'doc_1',
      sessionId: 'session_1',
      idleTimeoutSeconds: 3600,
    })).resolves.toBe(2);
    expect(calls[0]?.params).toEqual(['doc_1', 'session_1', 3600, LEGACY_DOCUMENT_QUOTA_KEY_PREFIX]);
    expect(calls[0]?.sql).toContain('target_workspace');
    expect(calls[0]?.sql).toContain("coalesce(workspace_id::text, $4 || id::text)");
    expect(calls[0]?.sql).toContain("coalesce(d.workspace_id::text, $4 || d.id::text)");
    expect(calls[0]?.sql).toContain('latest_guest_sessions');
    expect(calls[0]?.sql).toContain('from collab_sessions');
    expect(calls[0]?.sql).toContain('last_seen_at');
    expect(calls[0]?.sql).toContain("s.status = 'active'");
    expect(calls[0]?.sql).toContain('s.is_guest = true');
    expect(calls[0]?.sql).toContain("pti.status in ('pending', 'issued', 'revoked')");
    expect(calls[0]?.sql).not.toContain('s.actor_grant_id is not null');
    expect(calls[0]?.sql).not.toContain("'failed'");
    expect(calls[0]?.sql).not.toContain('valid_for_seconds');
    expect(calls[0]?.sql).toContain("case when pti.status = 'revoked' then 0 else 1 end");
  });

  it('uses the workspace plan concurrent guest quota before blocking new guest edit sessions', async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    let inserted = false;
    const query = async <Row = unknown>(sql: string, params: readonly unknown[] = []): Promise<DbQueryResult<Row>> => {
      calls.push({ sql, params });
      if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return { rows: [], rowCount: 0 };
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
      if (sql.includes('update collab_sessions')) return { rows: [], rowCount: 1 };
      if (sql.includes('coalesce(sl.concurrent_guest_edits')) return { rows: [{ concurrent_guest_edits: '10' } as Row], rowCount: 1 };
      if (sql.includes('count(*) as active_guest_sessions')) return { rows: [{ active_guest_sessions: '5' } as Row], rowCount: 1 };
      if (sql.includes('insert into provider_token_issuances')) {
        inserted = true;
        return { rows: [{ id: 'issuance_1' } as Row], rowCount: 1 };
      }
      throw new Error(`unexpected_query:${sql}`);
    };
    const pool = { query, connect: async () => ({ query, release: () => undefined }) };

    await expect(recordProviderTokenIssuanceWithPolicy(pool, {
      docId: 'doc_1',
      branchId: 'branch_1',
      providerDocId: 'provider_1',
      sessionId: 'session_1',
      clientKind: 'browser',
      actorType: 'user',
      actorId: 'session:session_1',
      actorGrantId: 'grant_1',
      authorization: 'full',
      validForSeconds: 600,
      status: 'pending',
      isGuestSession: true,
      enforceGuestQuota: true,
      guestQuota: 3,
      guestSessionIdleTimeoutSeconds: 3600,
    })).resolves.toEqual({ issuanceId: 'issuance_1' });

    expect(inserted).toBe(true);
    expect(calls.some((call) => call.sql.includes('seat_limits sl'))).toBe(true);
  });

  it('only applies paid concurrent guest quotas for usable subscriptions', async () => {
    let capturedSql = '';
    const pool = {
      async query<Row = unknown>(sql: string, params: readonly unknown[] = []): Promise<DbQueryResult<Row>> {
        capturedSql = sql;
        expect(params).toEqual(['doc_1', 3]);
        return { rows: [{ concurrent_guest_edits: '3' } as Row], rowCount: 1 };
      },
    };

    await expect(readConcurrentGuestEditQuota(pool, {
      docId: 'doc_1',
      fallbackQuota: 3,
    })).resolves.toBe(3);

    expect(capturedSql).toContain("s.status in ('manual', 'trialing', 'active')");
    expect(capturedSql).toContain('(s.current_period_end is null or s.current_period_end > now())');
  });

  it('uses the legacy fallback quota for documents without a workspace', async () => {
    let capturedSql = '';
    const pool = {
      async query<Row = unknown>(sql: string, params: readonly unknown[] = []): Promise<DbQueryResult<Row>> {
        capturedSql = sql;
        expect(params).toEqual(['legacy_doc', 7]);
        return { rows: [{ concurrent_guest_edits: '7' } as Row], rowCount: 1 };
      },
    };

    await expect(readConcurrentGuestEditQuota(pool, {
      docId: 'legacy_doc',
      fallbackQuota: 7,
    })).resolves.toBe(7);

    expect(capturedSql).toContain('case when d.workspace_id is null then $2');
    expect(capturedSql).toContain('else coalesce(sl.concurrent_guest_edits, $2)');
  });
});

describe('markProviderTokenIssuanceIssuedIfSessionActive', () => {
  it('preflights token issuance against the pending row document, branch, and session', async () => {
    let capturedSql = '';
    let capturedParams: readonly unknown[] = [];
    const pool = {
      async query<Row = unknown>(sql: string, params: readonly unknown[] = []): Promise<DbQueryResult<Row>> {
        capturedSql = sql;
        capturedParams = params;
        return { rows: [{ '?column?': 1 } as Row], rowCount: 1 };
      },
    };

    await expect(providerTokenIssuanceCanIssue(pool, {
      issuanceId: 'issuance_1',
      docId: 'doc_1',
      branchId: 'branch_1',
      sessionId: 'session_1',
    })).resolves.toBe(true);

    expect(capturedParams).toEqual(['issuance_1', 'doc_1', 'branch_1', 'session_1']);
    expect(capturedSql).toContain('pending.doc_id = $2');
    expect(capturedSql).toContain('pending.branch_id = $3');
    expect(capturedSql).toContain('pending.session_id = $4');
    expect(capturedSql).toContain("pending.status = 'pending'");
    expect(capturedSql).toContain('join collab_sessions');
    expect(capturedSql).toContain("s.mode = 'edit'");
    expect(capturedSql).toContain("s.status = 'active'");
    expect(capturedSql).toContain("pending.actor_type = 'user'");
    expect(capturedSql).toContain("pending.actor_id not like 'share:%'");
    expect(capturedSql).toContain("pending.actor_id not like 'access:%'");
    expect(capturedSql).toContain('workspace_members m');
    expect(capturedSql).toContain("m.role in ('Owner', 'Member')");
    expect(capturedSql).toContain('d.owner_id::text = pending.actor_id');
  });

  it('treats any revoked session row as terminal when completing a pending refresh', async () => {
    let capturedSql = '';
    let capturedParams: readonly unknown[] = [];
    const pool = {
      async query<Row = unknown>(sql: string, params: readonly unknown[] = []): Promise<DbQueryResult<Row>> {
        capturedSql = sql;
        capturedParams = params;
        return { rows: [], rowCount: 1 };
      },
    };

    await expect(markProviderTokenIssuanceIssuedIfSessionActive(pool, {
      issuanceId: 'issuance_1',
      docId: 'doc_1',
      branchId: 'branch_1',
      sessionId: 'session_1',
    })).resolves.toBe(true);

    expect(capturedParams).toEqual(['issuance_1', 'doc_1', 'branch_1', 'session_1']);
    expect(capturedSql).toContain('pending.doc_id = $2');
    expect(capturedSql).toContain('pending.branch_id = $3');
    expect(capturedSql).toContain('pending.session_id = $4');
    expect(capturedSql).toContain('from collab_sessions');
    expect(capturedSql).toContain("s.mode = 'edit'");
    expect(capturedSql).toContain("s.status = 'active'");
    expect(capturedSql).toContain('not exists');
    expect(capturedSql).toContain("revoked.status = 'revoked'");
    expect(capturedSql).toContain('from document_access_grants');
    expect(capturedSql).not.toContain('from share_links');
    expect(capturedSql).toContain('revoked_at is null');
    expect(capturedSql).toContain('expires_at is null or');
    expect(capturedSql).toContain('(g.branch_id = pending.branch_id or g.branch_id is null)');
    expect(capturedSql).toContain("pending.actor_type = 'user'");
    expect(capturedSql).toContain("pending.actor_id not like 'share:%'");
    expect(capturedSql).toContain("pending.actor_id not like 'access:%'");
    expect(capturedSql).toContain('workspace_members m');
    expect(capturedSql).toContain("m.role in ('Owner', 'Member')");
    expect(capturedSql).toContain('d.owner_id::text = pending.actor_id');
    expect(capturedSql).toContain("pending.actor_id in ('admin', 'dev-anonymous')");
    expect(capturedSql).not.toContain('revoked.issued_at >= pending.issued_at');
  });

  it('classifies provider token issuance denials for refresh errors', async () => {
    const { providerTokenIssuanceDenyReason } = await import('./provider-doc-service');
    let capturedSql = '';
    const pool = {
      async query<Row = unknown>(sql: string, params: readonly unknown[] = []): Promise<DbQueryResult<Row>> {
        capturedSql = sql;
        expect(params).toEqual(['issuance_1', 'doc_1', 'branch_1', 'session_1']);
        return { rows: [{ deny_reason: 'grant_revoked' } as Row], rowCount: 1 };
      },
    };

    await expect(providerTokenIssuanceDenyReason(pool, {
      issuanceId: 'issuance_1',
      docId: 'doc_1',
      branchId: 'branch_1',
      sessionId: 'session_1',
    })).resolves.toBe('grant_revoked');

    expect(capturedSql).toContain('provider_token_issuance_policy_reason');
    expect(capturedSql).toContain('grant_revoked');
    expect(capturedSql).toContain('grant_expired');
    expect(capturedSql).toContain('collab_session_not_found');
  });
});

describe('markProviderTokenRefreshIssued', () => {
  it('links refresh audit rows to the provider token issuance they produced', async () => {
    let capturedSql = '';
    let capturedParams: readonly unknown[] = [];
    const pool = {
      async query<Row = unknown>(sql: string, params: readonly unknown[] = []): Promise<DbQueryResult<Row>> {
        capturedSql = sql;
        capturedParams = params;
        return { rows: [], rowCount: 1 };
      },
    };

    await markProviderTokenRefreshIssued(pool, {
      refreshId: 'refresh_1',
      expiresAt: '2026-05-11T00:10:00.000Z',
      issuanceId: 'issuance_1',
    });

    expect(capturedParams).toEqual(['refresh_1', '2026-05-11T00:10:00.000Z', 'issuance_1']);
    expect(capturedSql).toContain('issuance_id = $3');
  });
});
