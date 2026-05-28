import { describe, expect, it } from 'vitest';
import type { DbPool, DbQueryResult, DbTransactionClient } from '../db/client';
import { toRoomName } from '../collab/persistence';
import { closeDirectUserRuntimeAccess } from './runtime-access-revocation-service';

interface CapturedQuery {
  sql: string;
  params?: readonly unknown[];
}

function createRuntimeRevocationPool() {
  const queries: CapturedQuery[] = [];
  const query: DbPool['query'] = async <Row = unknown>(sql: string, params?: readonly unknown[]): Promise<DbQueryResult<Row>> => {
    queries.push(params === undefined ? { sql } : { sql, params });
    if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return { rows: [], rowCount: 0 };
    if (sql.includes('select distinct s.doc_id')) {
      return {
        rows: [
          { doc_id: 'doc_1', branch_id: 'br_1', provider_doc_id: 'provider_doc_1' },
          { doc_id: 'doc_2', branch_id: 'br_2', provider_doc_id: 'provider_doc_2' },
        ] as Row[],
        rowCount: 2,
      };
    }
    if (sql.includes('update collab_sessions')) return { rows: [], rowCount: 2 };
    if (sql.includes('update provider_token_issuances')) return { rows: [], rowCount: 2 };
    throw new Error(`unexpected_query:${sql}`);
  };
  const pool: DbPool = {
    query,
    async connect(): Promise<DbTransactionClient> {
      return { query, release: () => undefined };
    },
  };
  return { pool, queries };
}

describe('runtime access revocation service', () => {
  it('closes active direct-user edit sessions and revokes pending provider issuances for a workspace scope', async () => {
    const { pool, queries } = createRuntimeRevocationPool();
    const closedRooms: string[] = [];
    const closedProviderDocs: string[][] = [];

    await closeDirectUserRuntimeAccess(pool, {
      closeCollabDocumentConnections(roomName) {
        closedRooms.push(roomName);
      },
      closeProviderDocConnections(providerDocIds) {
        closedProviderDocs.push([...providerDocIds]);
      },
    }, {
      userId: 'user_member',
      workspaceId: 'ws_1',
      providerError: 'workspace_member_access_revoked',
    });

    expect(queries.find((query) => query.sql.includes('select distinct s.doc_id'))?.params).toEqual(['user_member', 'ws_1']);
    const sessionUpdate = queries.find((query) => query.sql.includes('update collab_sessions'));
    expect(sessionUpdate?.sql).toContain("s.actor_type = 'user'");
    expect(sessionUpdate?.sql).toContain('s.actor_grant_id is null');
    expect(sessionUpdate?.sql).toContain('s.mode = \'edit\'');
    expect(sessionUpdate?.params).toEqual(['user_member', 'ws_1']);
    const issuanceUpdate = queries.find((query) => query.sql.includes('update provider_token_issuances'));
    expect(issuanceUpdate?.sql).toContain("pti.status in ('pending', 'issued')");
    expect(issuanceUpdate?.params).toEqual(['user_member', 'ws_1', 'workspace_member_access_revoked']);
    expect(closedRooms).toEqual([
      toRoomName('doc_1', 'br_1'),
      toRoomName('doc_2', 'br_2'),
    ]);
    expect(closedProviderDocs).toEqual([['provider_doc_1', 'provider_doc_2']]);
  });
});
