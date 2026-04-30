import { randomBytes, timingSafeEqual } from 'node:crypto';
import { sha256Hex } from '@marklab/shared/src/hash';
import type { DbPool } from '../db/client';

export type AccessOperation = 'read' | 'write';

export interface VerifiedDocumentAccess {
  actorType: 'agent' | 'user';
}

interface AgentTokenRow {
  can_read: boolean;
  can_write: boolean;
  expires_at: Date | string | null;
  revoked_at: Date | string | null;
}

interface ShareLinkRow {
  role: 'view' | 'edit';
  expires_at: Date | string | null;
  revoked_at: Date | string | null;
}

export function generateAgentToken(): string {
  return `ml_agent_${randomBytes(32).toString('base64url')}`;
}

export function generateShareToken(): string {
  return `ml_share_${randomBytes(32).toString('base64url')}`;
}

export function hashToken(token: string): string {
  return sha256Hex(token);
}

function hashesMatch(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.byteLength === expectedBuffer.byteLength && timingSafeEqual(actualBuffer, expectedBuffer);
}

export function verifyAdminToken(token: string | undefined, adminTokenHash: string | undefined): void {
  if (!adminTokenHash) throw new Error('admin_token_not_configured');
  if (!token || !hashesMatch(hashToken(token), adminTokenHash)) throw new Error('forbidden');
}

function isUsable(row: { expires_at?: Date | string | null; revoked_at?: Date | string | null }, now = Date.now()): boolean {
  if (row.revoked_at) return false;
  if (row.expires_at && new Date(row.expires_at).getTime() <= now) return false;
  return true;
}

export async function verifyDocumentAccess(
  pool: DbPool,
  token: string | undefined,
  docId: string,
  branchId: string,
  operation: AccessOperation,
): Promise<VerifiedDocumentAccess> {
  if (!token) throw new Error('forbidden');

  const tokenHash = hashToken(token);
  const [agentResult, shareResult] = await Promise.all([
    pool.query<AgentTokenRow>(
      `select can_read, can_write, expires_at, revoked_at
         from agent_tokens
        where token_hash = $1
          and doc_id = $2
          and (branch_id = $3 or branch_id is null)`,
      [tokenHash, docId, branchId],
    ),
    pool.query<ShareLinkRow>(
      `select role, expires_at, revoked_at
         from share_links
        where token_hash = $1
          and doc_id = $2
          and (branch_id = $3 or branch_id is null)`,
      [tokenHash, docId, branchId],
    ),
  ]);

  for (const row of agentResult.rows) {
    if (!isUsable(row)) continue;
    if (operation === 'read' && row.can_read) return { actorType: 'agent' };
    if (operation === 'write' && row.can_write) return { actorType: 'agent' };
  }

  for (const row of shareResult.rows) {
    if (!isUsable(row)) continue;
    if (operation === 'read') return { actorType: 'user' };
    if (operation === 'write' && row.role === 'edit') return { actorType: 'user' };
  }

  throw new Error('forbidden');
}
