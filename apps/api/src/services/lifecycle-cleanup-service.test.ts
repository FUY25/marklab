import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { DbPool, DbQueryResult } from '../db/client';
import { cleanupDataLifecycle, startDataLifecycleCleanupJob } from './lifecycle-cleanup-service';

interface CapturedQuery {
  sql: string;
  params?: readonly unknown[];
}

interface ProviderDeletionRow {
  id: string;
  provider_doc_id: string;
}

function createLifecyclePool(options: {
  providerDeletionRows?: ProviderDeletionRow[];
  activeProviderDocIds?: readonly string[];
  deleteRowCount?: number;
} = {}) {
  const queries: CapturedQuery[] = [];
  const statuses: Array<{ id: unknown; status: unknown; error: unknown }> = [];
  const activeProviderDocIds = new Set(options.activeProviderDocIds ?? []);

  const query: DbPool['query'] = async <Row = unknown>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<DbQueryResult<Row>> => {
    queries.push(params === undefined ? { sql } : { sql, params });
    const compact = sql.replace(/\s+/gu, ' ').trim();

    if (compact.includes('from provider_doc_deletions') && compact.includes("cleanup_status in ('pending', 'failed')")) {
      return {
        rows: (options.providerDeletionRows ?? []) as Row[],
        rowCount: options.providerDeletionRows?.length ?? 0,
      };
    }

    if (compact.includes('from document_branch_states') && compact.includes('provider_doc_id = $1')) {
      const providerDocId = String(params?.[0] ?? '');
      return {
        rows: activeProviderDocIds.has(providerDocId) ? [{ exists: 1 } as Row] : [],
        rowCount: activeProviderDocIds.has(providerDocId) ? 1 : 0,
      };
    }

    if (compact.startsWith('update provider_doc_deletions')) {
      statuses.push({ id: params?.[0], status: params?.[1], error: params?.[3] ?? null });
      return { rows: [], rowCount: 1 };
    }

    if (compact.startsWith('delete from')) {
      return { rows: [], rowCount: options.deleteRowCount ?? 2 };
    }

    return { rows: [], rowCount: 0 };
  };

  const pool: DbPool = {
    query,
    connect: async () => ({ query, release: () => undefined }),
  };
  return { pool, queries, statuses };
}

describe('cleanupDataLifecycle', () => {
  let tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
    tempRoots = [];
  });

  it('physically removes only tombstoned local Y-Sweet provider document directories', async () => {
    const storePath = await mkdtemp(join(tmpdir(), 'marklab-lifecycle-'));
    tempRoots.push(storePath);
    await mkdir(join(storePath, 'ml_doc_deleted'));
    await writeFile(join(storePath, 'ml_doc_deleted', 'data.ysweet'), 'deleted');
    await mkdir(join(storePath, 'ml_doc_live'));
    await writeFile(join(storePath, 'ml_doc_live', 'data.ysweet'), 'live');
    const { pool, statuses } = createLifecyclePool({
      providerDeletionRows: [{ id: 'del_1', provider_doc_id: 'ml_doc_deleted' }],
    });

    const result = await cleanupDataLifecycle({
      pool,
      providerStorePath: storePath,
      now: new Date('2026-05-22T12:00:00.000Z'),
      providerDocDeletionGraceMs: 0,
    });

    expect(existsSync(join(storePath, 'ml_doc_deleted'))).toBe(false);
    expect(existsSync(join(storePath, 'ml_doc_live'))).toBe(true);
    expect(result.providerDocs.completed).toBe(1);
    expect(result.providerDocs.failed).toBe(0);
    expect(statuses).toContainEqual({ id: 'del_1', status: 'complete', error: null });
  });

  it('does not remove unsafe or still-referenced provider document paths', async () => {
    const storePath = await mkdtemp(join(tmpdir(), 'marklab-lifecycle-'));
    tempRoots.push(storePath);
    await mkdir(join(storePath, 'ml_doc_active'));
    await writeFile(join(storePath, 'ml_doc_active', 'data.ysweet'), 'active');
    const { pool, statuses } = createLifecyclePool({
      providerDeletionRows: [
        { id: 'del_active', provider_doc_id: 'ml_doc_active' },
        { id: 'del_escape', provider_doc_id: '../outside' },
      ],
      activeProviderDocIds: ['ml_doc_active'],
    });

    const result = await cleanupDataLifecycle({
      pool,
      providerStorePath: storePath,
      now: new Date('2026-05-22T12:00:00.000Z'),
      providerDocDeletionGraceMs: 0,
    });

    expect(existsSync(join(storePath, 'ml_doc_active'))).toBe(true);
    expect(result.providerDocs.completed).toBe(0);
    expect(result.providerDocs.failed).toBe(2);
    expect(statuses).toContainEqual({ id: 'del_active', status: 'failed', error: 'provider_doc_still_referenced' });
    expect(statuses).toContainEqual({ id: 'del_escape', status: 'failed', error: 'provider_doc_id_not_direct_child' });
  });

  it('prunes stale auth/session/grant/token audit rows without hard-deleting users or workspaces', async () => {
    const { pool, queries } = createLifecyclePool();

    const result = await cleanupDataLifecycle({
      pool,
      now: new Date('2026-05-22T12:00:00.000Z'),
      providerDocDeletionGraceMs: 0,
    });

    const sql = queries.map((query) => query.sql.replace(/\s+/gu, ' ').toLowerCase()).join('\n');
    for (const table of [
      'oidc_login_states',
      'user_sessions',
      'workspace_share_keys',
      'document_access_grants',
      'document_access_sessions',
      'share_links',
      'agent_tokens',
      'provider_token_refreshes',
      'provider_token_issuances',
      'collab_sessions',
    ]) {
      expect(sql).toContain(`delete from ${table}`);
    }
    expect(sql).not.toContain('delete from users');
    expect(sql).not.toContain('delete from workspaces');
    expect(result.rowsDeleted).toBeGreaterThan(0);
  });
});

describe('startDataLifecycleCleanupJob', () => {
  it('does not overlap scheduled cleanup runs', async () => {
    let releaseFirstRun: (() => void) | undefined;
    let runCount = 0;
    const pool = createLifecyclePool().pool;

    const job = startDataLifecycleCleanupJob({
      pool,
      intervalMs: 60_000,
      cleanup: async () => {
        runCount += 1;
        await new Promise<void>((resolve) => {
          releaseFirstRun = resolve;
        });
        return {
          rowsDeleted: 0,
          providerDocs: { checked: 0, completed: 0, failed: 0, skipped: 0 },
        };
      },
    });

    const firstRun = job.runNow();
    await Promise.resolve();
    await expect(job.runNow()).resolves.toBeNull();
    releaseFirstRun?.();
    await firstRun;
    job.stop();

    expect(runCount).toBe(1);
  });
});
