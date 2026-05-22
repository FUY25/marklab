import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { DbPool, DbQueryResult, DbTransactionClient } from '../db/client';
import { createHttpApp } from '../http/app';
import { createUnavailableLiveMarkdownWriter } from '../services/live-writer';
import { hashToken } from '../services/access-control';
import { toRoomName } from '../collab/persistence';

interface CapturedQuery {
  sql: string;
  params?: readonly unknown[];
}

function createRoutePool(input: { accessToken: string }) {
  const queries: CapturedQuery[] = [];
  let deleted = false;

  const query: DbPool['query'] = async <Row = unknown>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<DbQueryResult<Row>> => {
    queries.push(params === undefined ? { sql } : { sql, params });

    if (/from agent_tokens/u.test(sql) && /token_hash = \$1/u.test(sql)) {
      return { rows: [], rowCount: 0 };
    }

    if (/from document_access_grants/u.test(sql) && /token_hash = \$1/u.test(sql)) {
      if (deleted || params?.[0] !== hashToken(input.accessToken)) return { rows: [], rowCount: 0 };
      return {
        rows: [{ id: 'grant_old', role: 'edit', expires_at: null, revoked_at: null } as Row],
        rowCount: 1,
      };
    }

    if (sql.includes('select b.id as branch_id') && sql.includes('provider_doc_id')) {
      if (deleted) return { rows: [], rowCount: 0 };
      return {
        rows: [{ branch_id: 'br_main', provider_doc_id: 'ml_doc_1' } as Row],
        rowCount: 1,
      };
    }

    if (sql.includes('insert into provider_doc_deletions')) {
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes('delete from documents')) {
      deleted = true;
      return { rows: [{ id: 'doc_001' } as Row], rowCount: 1 };
    }

    if (/from provider_token_issuances/u.test(sql)) {
      return { rows: [], rowCount: 0 };
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

describe('cloud copy routes', () => {
  it('deletes a cloud copy and denies old links and provider-token refreshes', async () => {
    const accessToken = 'ml_access_old';
    const { pool, queries } = createRoutePool({ accessToken });
    const closedRooms: string[] = [];
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter(), {
      auth: {
        async requireAdminAccess() {
          throw new Error('forbidden');
        },
        async requireDocumentAccess(_req, docId, branchId, operation) {
          expect({ docId, branchId, operation }).toEqual({
            docId: 'doc_001',
            branchId: 'br_main',
            operation: 'write',
          });
          return { actorType: 'user', actorId: 'user_owner', role: 'edit', canManageAccess: true };
        },
      },
      closeCollabDocumentConnections(roomName) {
        closedRooms.push(roomName);
      },
    });

    await request(app)
      .delete('/api/docs/doc_001/branches/br_main/cloud-copy')
      .expect(200, {
        deleted: true,
        docId: 'doc_001',
        branchIds: ['br_main'],
        providerDocIds: ['ml_doc_1'],
        localFilePreserved: true,
      });

    expect(closedRooms).toEqual([toRoomName('doc_001', 'br_main')]);

    await request(app)
      .get('/api/docs/doc_001/branches/br_main/access')
      .query({ token: accessToken })
      .expect(403, { error: 'forbidden' });

    await request(app)
      .post('/api/docs/doc_001/branches/br_main/collab/session/session_old/provider-token/refresh')
      .send({ refreshToken: 'x'.repeat(32) })
      .expect(404, { error: 'collab_session_not_found' });

    expect(queries.some((query) => query.sql.includes('delete from documents'))).toBe(true);
  });

  it('rejects cloud copy deletion for branch-scoped edit links without management access', async () => {
    const { pool } = createRoutePool({ accessToken: 'ml_access_old' });
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter(), {
      auth: {
        async requireAdminAccess() {
          throw new Error('forbidden');
        },
        async requireDocumentAccess() {
          return { actorType: 'user', actorId: 'share:old', grantId: 'grant_old', role: 'edit' };
        },
      },
    });

    await request(app)
      .delete('/api/docs/doc_001/branches/br_main/cloud-copy')
      .expect(403, { error: 'forbidden' });
  });
});
