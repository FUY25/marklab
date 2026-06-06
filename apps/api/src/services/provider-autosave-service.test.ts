import { describe, expect, it } from 'vitest';
import { sha256Hex } from '@marklab/shared/src/hash';
import * as Y from 'yjs';
import type { CollabSnapshotService } from '../http/app';
import type { DbPool, DbQueryResult, DbTransactionClient } from '../db/client';
import { autosaveProviderBackedBranches, startProviderAutosaveCheckpointJob } from './provider-autosave-service';

interface CapturedQuery {
  sql: string;
  params?: readonly unknown[];
}

function createAutosavePool(input: { liveMarkdown: string }) {
  const queries: CapturedQuery[] = [];
  const liveHash = sha256Hex(input.liveMarkdown);
  const finalQuietStartedAt = new Date(Date.now() - 3 * 60 * 1000);

  const query: DbPool['query'] = async <Row = unknown>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<DbQueryResult<Row>> => {
    queries.push(params === undefined ? { sql } : { sql, params });

    if (sql.includes('provider_doc_id is not null')) {
      return {
        rows: [{ doc_id: 'doc_live', branch_id: 'br_main' } as Row],
        rowCount: 1,
      };
    }

    if (sql.includes('select b.head_version_id')) {
      return {
        rows: [{
          head_version_id: 'ver_001',
          head_version_number: 1,
          head_hash: 'sha256:old',
          current_hash: 'sha256:old',
        } as Row],
        rowCount: 1,
      };
    }

    if (sql.includes('update document_branch_states')) {
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes('from document_branch_autosave_state')) {
      return {
        rows: [{
          pending_hash: liveHash,
          active_started_at: finalQuietStartedAt,
          pending_first_seen_at: finalQuietStartedAt,
        } as Row],
        rowCount: 1,
      };
    }

    if (sql.includes('select max(created_at) as last_autosave_at')) {
      return { rows: [{ last_autosave_at: null } as Row], rowCount: 1 };
    }

    if (sql.includes('select coalesce(max(version_number), 0) + 1')) {
      return { rows: [{ next_version_number: 2 } as Row], rowCount: 1 };
    }

    if (sql.includes('insert into document_versions')) {
      return { rows: [{ id: 'ver_auto' } as Row], rowCount: 1 };
    }

    if (sql.includes('update document_branches')) {
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes('delete from document_branch_autosave_state')) {
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes('select max(created_at) as branch_edit_clock')) {
      return { rows: [{ branch_edit_clock: new Date() } as Row], rowCount: 1 };
    }

    if (sql.includes('select id') && sql.includes('operation = \'autosave\'') && sql.includes('created_at <')) {
      return { rows: [], rowCount: 0 };
    }

    if (sql === 'begin' || sql === 'commit' || sql === 'rollback') {
      return { rows: [], rowCount: 0 };
    }

    throw new Error(`unexpected query: ${sql}`);
  };

  const client: DbTransactionClient = {
    query,
    release: () => undefined,
  };

  const pool: DbPool = {
    query,
    connect: async () => client,
  };

  return { pool, queries, liveHash };
}

describe('autosaveProviderBackedBranches', () => {
  it('creates autosave checkpoints from the active provider snapshot for browser or app edits', async () => {
    const liveMarkdown = '# Live provider text\n\nWritten from browser or app.\n';
    const { pool, queries, liveHash } = createAutosavePool({ liveMarkdown });
    const ydoc = new Y.Doc();
    ydoc.getText('contents').insert(0, liveMarkdown);
    const yjsState = Y.encodeStateAsUpdate(ydoc);
    const snapshots: Array<{ docId: string; branchId: string }> = [];
    const collabSnapshotService: CollabSnapshotService = {
      async readCurrentMarkdownSnapshot({ docId, branchId }) {
        snapshots.push({ docId, branchId });
        return {
          docId,
          branchId,
          versionId: null,
          versionNumber: null,
          markdown: liveMarkdown,
          hash: liveHash,
          yjsState,
        };
      },
    };

    const result = await autosaveProviderBackedBranches({ pool, collabSnapshotService });

    expect(result).toEqual({ checked: 1, created: 1, unchanged: 0, failed: 0 });
    expect(snapshots).toEqual([{ docId: 'doc_live', branchId: 'br_main' }]);
    const versionInsert = queries.find((query) => query.sql.includes('insert into document_versions'));
    expect(versionInsert?.params).toMatchObject([
      'doc_live',
      'br_main',
      'ver_001',
      2,
      liveMarkdown,
      liveHash,
      'system',
      'provider-autosave',
      'autosave',
    ]);
    const stateUpdate = queries.find((query) => query.sql.includes('update document_branch_states'));
    expect(stateUpdate?.params?.[1]).toBe(liveMarkdown);
    expect(stateUpdate?.params?.[2]).toBe(liveHash);
  });
});

describe('startProviderAutosaveCheckpointJob', () => {
  it('skips scheduled database work while the provider has no active editing activity', async () => {
    let queries = 0;
    const pool: DbPool = {
      async query() {
        queries += 1;
        throw new Error('database_should_not_be_checked');
      },
      connect: async () => {
        queries += 1;
        throw new Error('database_should_not_be_checked');
      },
    };
    const collabSnapshotService: CollabSnapshotService = {
      async readCurrentMarkdownSnapshot() {
        throw new Error('should_not_reach_snapshot');
      },
    };

    const job = startProviderAutosaveCheckpointJob({
      pool,
      collabSnapshotService,
      intervalMs: 20,
      shouldRun: () => false,
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 60));
    } finally {
      job.stop();
    }

    expect(queries).toBe(0);
  });

  it('reports scheduled run-level failures instead of creating unhandled interval rejections', async () => {
    const errors: unknown[] = [];
    const pool: DbPool = {
      async query() {
        throw new Error('database_down');
      },
      connect: async () => {
        throw new Error('database_down');
      },
    };
    const collabSnapshotService: CollabSnapshotService = {
      async readCurrentMarkdownSnapshot() {
        throw new Error('should_not_reach_snapshot');
      },
    };

    const job = startProviderAutosaveCheckpointJob({
      pool,
      collabSnapshotService,
      intervalMs: 20,
      onError(error) {
        errors.push(error);
      },
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 60));
    } finally {
      job.stop();
    }

    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toBeInstanceOf(Error);
    expect(errors.every((error) => error instanceof Error && error.message === 'database_down')).toBe(true);
  });
});
