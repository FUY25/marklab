import { describe, expect, it } from 'vitest';
import { sha256Hex } from '@marklab/shared/src/hash';
import type { DbPool, DbQueryResult, DbTransactionClient } from '../db/client';
import {
  generateAgentToken,
  generateShareToken,
  hashToken,
  verifyAdminToken,
  verifyDocumentAccess,
} from './access-control';

interface AccessRow {
  token_hash: string;
  doc_id: string;
  branch_id: string | null;
  can_read?: boolean;
  can_write?: boolean;
  role?: 'view' | 'edit';
  expires_at?: Date | string | null;
  revoked_at?: Date | string | null;
}

function createAccessPool(rows: { agentTokens?: AccessRow[]; shareLinks?: AccessRow[] }) {
  const query: DbPool['query'] = async <Row = unknown>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<DbQueryResult<Row>> => {
    const [tokenHash, docId, branchId] = params ?? [];
    const matches = (row: AccessRow) =>
      row.token_hash === tokenHash &&
      row.doc_id === docId &&
      (row.branch_id === branchId || row.branch_id === null);

    if (sql.includes('from agent_tokens')) {
      return { rows: (rows.agentTokens ?? []).filter(matches) as Row[], rowCount: rows.agentTokens?.length ?? 0 };
    }

    if (sql.includes('from share_links')) {
      return { rows: (rows.shareLinks ?? []).filter(matches) as Row[], rowCount: rows.shareLinks?.length ?? 0 };
    }

    return { rows: [], rowCount: 0 };
  };

  const client: DbTransactionClient = {
    query,
    release: () => undefined,
  };

  return {
    query,
    connect: async () => client,
  } satisfies DbPool;
}

describe('access-control service', () => {
  it('generates URL-safe agent and share tokens with the expected prefixes', () => {
    expect(generateAgentToken()).toMatch(/^ml_agent_[A-Za-z0-9_-]{43,}$/u);
    expect(generateShareToken()).toMatch(/^ml_share_[A-Za-z0-9_-]{43,}$/u);
  });

  it('hashes tokens without returning the raw secret', () => {
    const rawToken = 'ml_agent_secret-value';

    expect(hashToken(rawToken)).toBe(sha256Hex(rawToken));
    expect(hashToken(rawToken)).not.toBe(rawToken);
  });

  it('verifies admin tokens only against a configured hash', () => {
    const adminToken = 'admin-secret';

    expect(() => verifyAdminToken(adminToken, hashToken(adminToken))).not.toThrow();
    expect(() => verifyAdminToken(undefined, hashToken(adminToken))).toThrow('forbidden');
    expect(() => verifyAdminToken('wrong-token', hashToken(adminToken))).toThrow('forbidden');
    expect(() => verifyAdminToken(adminToken, undefined)).toThrow('admin_token_not_configured');
  });

  it('accepts a valid agent read token for read access', async () => {
    const rawToken = generateAgentToken();
    const pool = createAccessPool({
      agentTokens: [
        {
          token_hash: hashToken(rawToken),
          doc_id: 'doc_001',
          branch_id: 'br_main',
          can_read: true,
          can_write: false,
          expires_at: new Date(Date.now() + 60_000),
          revoked_at: null,
        },
      ],
    });

    await expect(verifyDocumentAccess(pool, rawToken, 'doc_001', 'br_main', 'read')).resolves.toEqual({
      actorType: 'agent',
    });
  });

  it('rejects revoked, expired, and read-only tokens for write access', async () => {
    const revokedToken = generateAgentToken();
    const expiredToken = generateAgentToken();
    const readOnlyToken = generateAgentToken();
    const pool = createAccessPool({
      agentTokens: [
        {
          token_hash: hashToken(revokedToken),
          doc_id: 'doc_001',
          branch_id: 'br_main',
          can_read: true,
          can_write: true,
          revoked_at: new Date(),
        },
        {
          token_hash: hashToken(expiredToken),
          doc_id: 'doc_001',
          branch_id: 'br_main',
          can_read: true,
          can_write: true,
          expires_at: new Date(Date.now() - 60_000),
        },
        {
          token_hash: hashToken(readOnlyToken),
          doc_id: 'doc_001',
          branch_id: 'br_main',
          can_read: true,
          can_write: false,
        },
      ],
    });

    await expect(verifyDocumentAccess(pool, revokedToken, 'doc_001', 'br_main', 'read')).rejects.toThrow('forbidden');
    await expect(verifyDocumentAccess(pool, expiredToken, 'doc_001', 'br_main', 'read')).rejects.toThrow('forbidden');
    await expect(verifyDocumentAccess(pool, readOnlyToken, 'doc_001', 'br_main', 'write')).rejects.toThrow('forbidden');
  });

  it('treats view share links as read-only and edit share links as write-capable', async () => {
    const viewToken = generateShareToken();
    const editToken = generateShareToken();
    const pool = createAccessPool({
      shareLinks: [
        {
          token_hash: hashToken(viewToken),
          doc_id: 'doc_001',
          branch_id: null,
          role: 'view',
        },
        {
          token_hash: hashToken(editToken),
          doc_id: 'doc_001',
          branch_id: 'br_main',
          role: 'edit',
        },
      ],
    });

    await expect(verifyDocumentAccess(pool, viewToken, 'doc_001', 'br_main', 'read')).resolves.toEqual({
      actorType: 'user',
    });
    await expect(verifyDocumentAccess(pool, viewToken, 'doc_001', 'br_main', 'write')).rejects.toThrow('forbidden');
    await expect(verifyDocumentAccess(pool, editToken, 'doc_001', 'br_main', 'write')).resolves.toEqual({
      actorType: 'user',
    });
  });
});
