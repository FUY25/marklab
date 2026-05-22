import { describe, expect, it } from 'vitest';
import type { DbPool, DbQueryResult, DbTransactionClient } from '../db/client';
import { deleteCloudCopy, isProviderDocDeleted } from './cloud-copy-service';

interface CapturedQuery {
  sql: string;
  params?: readonly unknown[];
}

function createCloudCopyPool() {
  const queries: CapturedQuery[] = [];

  const query: DbPool['query'] = async <Row = unknown>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<DbQueryResult<Row>> => {
    queries.push(params === undefined ? { sql } : { sql, params });

    if (sql.includes('select b.id as branch_id') && sql.includes('provider_doc_id')) {
      return {
        rows: [
          { branch_id: 'br_main', provider_doc_id: 'ml_doc_1' } as Row,
          { branch_id: 'br_notes', provider_doc_id: null } as Row,
        ],
        rowCount: 2,
      };
    }

    if (sql.includes('insert into provider_doc_deletions')) {
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes('select 1') && sql.includes('from provider_doc_deletions')) {
      return { rows: params?.[0] === 'ml_doc_1' ? [{ exists: 1 } as Row] : [], rowCount: params?.[0] === 'ml_doc_1' ? 1 : 0 };
    }

    if (sql.includes('delete from documents')) {
      return { rows: [{ id: 'doc_001' } as Row], rowCount: 1 };
    }

    if (/^(begin|commit|rollback|set constraints all deferred)$/iu.test(sql.trim())) {
      return { rows: [], rowCount: 0 };
    }

    return { rows: [], rowCount: 1 };
  };

  const client: DbTransactionClient = {
    query,
    release: () => undefined,
  };

  const pool: DbPool = {
    query,
    connect: async () => client,
  };

  return { pool, queries };
}

describe('deleteCloudCopy', () => {
  it('revokes hosted access, closes sessions, tombstones provider docs, and deletes the cloud document', async () => {
    const { pool, queries } = createCloudCopyPool();

    await expect(deleteCloudCopy({
      pool,
      docId: 'doc_001',
      branchId: 'br_main',
      actorType: 'user',
      actorId: 'user_owner',
    })).resolves.toEqual({
      docId: 'doc_001',
      branchIds: ['br_main', 'br_notes'],
      providerDocIds: ['ml_doc_1'],
    });

    expect(queries.some((query) => query.sql.includes('update document_access_grants') && query.sql.includes('revoked_at'))).toBe(true);
    expect(queries.some((query) => query.sql.includes('update collab_sessions') && query.sql.includes("status = 'closed'"))).toBe(true);
    expect(queries.some((query) => query.sql.includes('update provider_token_issuances') && query.sql.includes("status = 'revoked'"))).toBe(true);
    expect(queries.some((query) => query.sql.includes('delete from provider_token_refreshes'))).toBe(true);
    expect(queries.some((query) => query.sql.includes('delete from provider_token_issuances'))).toBe(true);
    expect(queries.some((query) => query.sql.includes('delete from collab_sessions'))).toBe(true);
    expect(queries.some((query) => query.sql.includes('delete from documents'))).toBe(true);
    const tombstone = queries.find((query) => query.sql.includes('insert into provider_doc_deletions'));
    expect(tombstone?.params).toEqual(['doc_001', 'br_main', 'ml_doc_1', 'user', 'user_owner']);
  });

  it('exposes deleted provider doc tombstones for proxy denial', async () => {
    const { pool } = createCloudCopyPool();

    await expect(isProviderDocDeleted(pool, 'ml_doc_1')).resolves.toBe(true);
    await expect(isProviderDocDeleted(pool, 'ml_doc_live')).resolves.toBe(false);
  });
});
