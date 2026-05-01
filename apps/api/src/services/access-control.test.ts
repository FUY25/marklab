import { describe, expect, it } from 'vitest';
import { sha256Hex } from '@marklab/shared/src/hash';
import type { DbPool, DbQueryResult, DbTransactionClient } from '../db/client';
import {
  createOrUpdateAccessSession,
  generateAccessToken,
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
  id?: string;
  client_id?: string;
  client_kind?: 'browser' | 'agent' | 'api';
  display_name?: string;
  color?: string;
  last_branch_id?: string | null;
  created_at?: Date | string;
  last_seen_at?: Date | string;
  branch_doc_id?: string;
}

function createAccessPool(rows: { agentTokens?: AccessRow[]; shareLinks?: AccessRow[]; accessGrants?: AccessRow[]; accessSessions?: AccessRow[] }) {
  let nextSessionId = 1;

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

    if (sql.includes('from access_grants') && sql.includes('token_hash = $1')) {
      const grants = (rows.accessGrants ?? []).filter(
        (row) => matches(row) && (row.branch_doc_id === undefined || row.branch_doc_id === row.doc_id),
      );
      return { rows: grants as Row[], rowCount: grants.length };
    }

    if (sql.includes('select id') && sql.includes('from access_grants') && sql.includes('for update')) {
      const grant = (rows.accessGrants ?? []).find(
        (row) => row.id === params?.[0] && row.doc_id === params?.[1] && row.branch_id === params?.[2],
      );
      return { rows: (grant ? [grant] : []) as Row[], rowCount: grant ? 1 : 0 };
    }

    if (sql.includes('from access_sessions') && sql.includes('grant_id = $1') && sql.includes('client_id = $2')) {
      const session = (rows.accessSessions ?? []).find((row) => row.id && row.id === params?.[0]);
      return { rows: (session ? [session] : []) as Row[], rowCount: session ? 1 : 0 };
    }

    if (sql.includes('from access_sessions') && sql.includes('display_name like')) {
      const grantId = params?.[0];
      return {
        rows: (rows.accessSessions ?? []).filter((row) => row.token_hash === grantId && row.display_name?.startsWith('Guest ')) as Row[],
        rowCount: rows.accessSessions?.length ?? 0,
      };
    }

    if (sql.includes('insert into access_sessions')) {
      const session: AccessRow = {
        id: `ses_${nextSessionId++}`,
        token_hash: String(params?.[0]),
        doc_id: '',
        branch_id: null,
        client_id: String(params?.[1]),
        client_kind: params?.[2] as 'browser' | 'agent' | 'api',
        display_name: String(params?.[3]),
        color: String(params?.[4]),
        last_branch_id: String(params?.[5]),
        created_at: new Date('2026-05-01T12:00:00Z'),
        last_seen_at: new Date('2026-05-01T12:00:00Z'),
      };
      rows.accessSessions?.push(session);
      return { rows: [session as Row], rowCount: 1 };
    }

    if (sql.includes('update access_sessions')) {
      const session = (rows.accessSessions ?? []).find((row) => row.token_hash === params?.[0] && row.client_id === params?.[1]);
      if (!session) return { rows: [], rowCount: 0 };
      const nextName = String(params?.[3] ?? '').trim();
      if (nextName) session.display_name = nextName;
      session.last_branch_id = String(params?.[2]);
      session.last_seen_at = new Date('2026-05-01T12:05:00Z');
      return { rows: [session as Row], rowCount: 1 };
    }

    if (sql === 'begin' || sql === 'commit' || sql === 'rollback') {
      return { rows: [], rowCount: 0 };
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
    expect(generateAccessToken()).toMatch(/^ml_access_[A-Za-z0-9_-]{43,}$/u);
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

  it('accepts access grants only for the exact shared document branch and role', async () => {
    const viewToken = generateAccessToken();
    const editToken = generateAccessToken();
    const pool = createAccessPool({
      accessGrants: [
        {
          id: 'grant_view',
          token_hash: hashToken(viewToken),
          doc_id: 'doc_001',
          branch_id: 'br_main',
          role: 'view',
        },
        {
          id: 'grant_edit',
          token_hash: hashToken(editToken),
          doc_id: 'doc_001',
          branch_id: 'br_main',
          role: 'edit',
        },
      ],
    });

    await expect(verifyDocumentAccess(pool, viewToken, 'doc_001', 'br_main', 'read')).resolves.toMatchObject({
      actorType: 'user',
      grantId: 'grant_view',
      role: 'view',
    });
    await expect(verifyDocumentAccess(pool, viewToken, 'doc_001', 'br_main', 'write')).rejects.toThrow('forbidden');
    await expect(verifyDocumentAccess(pool, viewToken, 'doc_001', 'br_other', 'read')).rejects.toThrow('forbidden');
    await expect(verifyDocumentAccess(pool, viewToken, 'doc_002', 'br_main', 'read')).rejects.toThrow('forbidden');
    await expect(verifyDocumentAccess(pool, editToken, 'doc_001', 'br_main', 'write')).resolves.toMatchObject({
      actorType: 'user',
      grantId: 'grant_edit',
      role: 'edit',
    });
  });

  it('rejects revoked access grants for reads and writes', async () => {
    const rawToken = generateAccessToken();
    const pool = createAccessPool({
      accessGrants: [
        {
          id: 'grant_revoked',
          token_hash: hashToken(rawToken),
          doc_id: 'doc_001',
          branch_id: 'br_main',
          role: 'edit',
          revoked_at: new Date(),
        },
      ],
    });

    await expect(verifyDocumentAccess(pool, rawToken, 'doc_001', 'br_main', 'read')).rejects.toThrow('forbidden');
    await expect(verifyDocumentAccess(pool, rawToken, 'doc_001', 'br_main', 'write')).rejects.toThrow('forbidden');
  });

  it('rejects access grants when the branch does not belong to the grant document', async () => {
    const rawToken = generateAccessToken();
    const pool = createAccessPool({
      accessGrants: [
        {
          id: 'grant_bad_branch_doc',
          token_hash: hashToken(rawToken),
          doc_id: 'doc_001',
          branch_id: 'br_foreign',
          branch_doc_id: 'doc_other',
          role: 'edit',
          revoked_at: null,
        },
      ],
    });

    await expect(verifyDocumentAccess(pool, rawToken, 'doc_001', 'br_foreign', 'read')).rejects.toThrow('forbidden');
    await expect(verifyDocumentAccess(pool, rawToken, 'doc_001', 'br_foreign', 'write')).rejects.toThrow('forbidden');
  });

  it('creates named and blank access sessions with stable identity per grant and client', async () => {
    const pool = createAccessPool({
      accessGrants: [
        {
          id: 'grant_edit',
          token_hash: 'unused',
          doc_id: 'doc_001',
          branch_id: 'br_main',
          role: 'edit',
        },
      ],
      accessSessions: [],
    });

    await expect(
      createOrUpdateAccessSession(pool, {
        grantId: 'grant_edit',
        docId: 'doc_001',
        branchId: 'br_main',
        clientId: 'browser_alex',
        clientKind: 'browser',
        displayName: '  Alex  ',
      }),
    ).resolves.toMatchObject({
      sessionId: 'ses_1',
      grantId: 'grant_edit',
      displayName: 'Alex',
      clientKind: 'browser',
      lastBranchId: 'br_main',
      color: expect.stringMatching(/^#[0-9a-f]{6}$/iu),
    });

    await expect(
      createOrUpdateAccessSession(pool, {
        grantId: 'grant_edit',
        docId: 'doc_001',
        branchId: 'br_main',
        clientId: 'browser_blank_1',
        clientKind: 'browser',
        displayName: ' ',
      }),
    ).resolves.toMatchObject({ sessionId: 'ses_2', displayName: 'Guest 1' });

    await expect(
      createOrUpdateAccessSession(pool, {
        grantId: 'grant_edit',
        docId: 'doc_001',
        branchId: 'br_main',
        clientId: 'browser_blank_2',
        clientKind: 'browser',
        displayName: '',
      }),
    ).resolves.toMatchObject({ sessionId: 'ses_3', displayName: 'Guest 2' });

    const repeat = await createOrUpdateAccessSession(pool, {
      grantId: 'grant_edit',
      docId: 'doc_001',
      branchId: 'br_main',
      clientId: 'browser_alex',
      clientKind: 'browser',
      displayName: 'Blair',
    });
    expect(repeat).toMatchObject({ sessionId: 'ses_1', displayName: 'Blair', lastBranchId: 'br_main' });
  });
});
