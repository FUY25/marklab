import { randomBytes, timingSafeEqual } from 'node:crypto';
import { sha256Hex } from '@marklab/shared/src/hash';
import type { DbPool } from '../db/client';
import { withTransaction } from '../db/client';

export type AccessOperation = 'read' | 'write';
export type AccessGrantRole = 'view' | 'edit';
export type AccessClientKind = 'browser' | 'app' | 'agent' | 'api';
export type AccessActorKind = 'user' | 'guest' | 'agent';
export type DocumentGrantSource = 'document_access_grants';

export interface VerifiedDocumentAccess {
  actorType: 'agent' | 'user';
  actorId?: string;
  grantId?: string;
  grantSource?: DocumentGrantSource;
  canManageAccess?: boolean;
  role?: AccessGrantRole;
}

interface AgentTokenRow {
  can_read: boolean;
  can_write: boolean;
  expires_at: Date | string | null;
  revoked_at: Date | string | null;
}

interface AccessGrantRow {
  id: string;
  role: AccessGrantRole;
  expires_at: Date | string | null;
  revoked_at: Date | string | null;
}

interface AccessSessionRow {
  id: string;
  grant_id?: string;
  token_hash?: string;
  client_id: string;
  client_kind: AccessClientKind;
  display_name: string;
  color: string;
  last_branch_id: string | null;
  created_at: Date | string;
  last_seen_at: Date | string;
}

export interface CreateOrUpdateAccessSessionInput {
  grantId: string;
  docId: string;
  branchId: string;
  clientId: string;
  clientKind: AccessClientKind;
  displayName: string;
}

export interface AccessSessionIdentity {
  grantId: string;
  sessionId: string;
  clientId: string;
  clientKind: AccessClientKind;
  displayName: string;
  color: string;
  lastBranchId: string | null;
  createdAt: string;
  lastSeenAt: string;
}

export function generateAgentToken(): string {
  return `ml_agent_${randomBytes(32).toString('base64url')}`;
}

export function generateShareToken(): string {
  return `ml_share_${randomBytes(32).toString('base64url')}`;
}

export function generateAccessToken(): string {
  return `ml_access_${randomBytes(32).toString('base64url')}`;
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

export function isAdminToken(token: string | undefined, adminTokenHash: string | undefined): boolean {
  if (!token || !adminTokenHash) return false;
  return hashesMatch(hashToken(token), adminTokenHash);
}

function isUsable(row: { expires_at?: Date | string | null; revoked_at?: Date | string | null }, now = Date.now()): boolean {
  if (row.revoked_at) return false;
  if (row.expires_at && new Date(row.expires_at).getTime() <= now) return false;
  return true;
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function sessionFromRow(row: AccessSessionRow): AccessSessionIdentity {
  return {
    grantId: row.grant_id ?? row.token_hash ?? '',
    sessionId: row.id,
    clientId: row.client_id,
    clientKind: row.client_kind,
    displayName: row.display_name,
    color: row.color,
    lastBranchId: row.last_branch_id,
    createdAt: toIsoString(row.created_at),
    lastSeenAt: toIsoString(row.last_seen_at),
  };
}

function colorForSession(grantId: string, clientId: string): string {
  return `#${sha256Hex(`${grantId}:${clientId}`).replace(/^sha256:/u, '').slice(0, 6)}`;
}

function nextGuestName(rows: Array<{ display_name: string }>): string {
  let maxGuestNumber = 0;
  for (const row of rows) {
    const match = /^Guest\s+(\d+)$/u.exec(row.display_name);
    if (!match?.[1]) continue;
    maxGuestNumber = Math.max(maxGuestNumber, Number(match[1]));
  }
  return `Guest ${maxGuestNumber + 1}`;
}

function documentGrantActorId(token: string, tokenHash: string): string {
  const prefix = token.startsWith('ml_share_') ? 'share' : 'access';
  return `${prefix}:${tokenHash}`;
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
  const [agentResult, accessGrantResult] = await Promise.all([
    pool.query<AgentTokenRow>(
      `select t.can_read, t.can_write, t.expires_at, t.revoked_at
         from agent_tokens t
         join document_branches b
           on b.id = $3
          and b.doc_id = t.doc_id
          and b.is_archived = false
        where t.token_hash = $1
          and t.doc_id = $2
          and (t.branch_id = $3 or t.branch_id is null)`,
      [tokenHash, docId, branchId],
    ),
    pool.query<AccessGrantRow>(
      `select g.id, g.role, g.expires_at, g.revoked_at
         from document_access_grants g
         join document_branches b
           on b.id = $3
          and b.doc_id = g.doc_id
          and b.is_archived = false
        where g.token_hash = $1
          and g.doc_id = $2
          and (g.branch_id = $3 or g.branch_id is null)`,
      [tokenHash, docId, branchId],
    ),
  ]);

  for (const row of accessGrantResult.rows) {
    if (!isUsable(row)) continue;
    const actorId = documentGrantActorId(token, tokenHash);
    if (operation === 'read') return { actorType: 'user', actorId, grantId: row.id, grantSource: 'document_access_grants', role: row.role };
    if (operation === 'write' && row.role === 'edit') {
      return { actorType: 'user', actorId, grantId: row.id, grantSource: 'document_access_grants', role: row.role };
    }
  }

  for (const row of agentResult.rows) {
    if (!isUsable(row)) continue;
    if (operation === 'read' && row.can_read) return { actorType: 'agent', actorId: `agent:${tokenHash}` };
    if (operation === 'write' && row.can_write) return { actorType: 'agent', actorId: `agent:${tokenHash}` };
  }

  throw new Error('forbidden');
}

export async function createOrUpdateAccessSession(
  pool: DbPool,
  input: CreateOrUpdateAccessSessionInput,
): Promise<AccessSessionIdentity> {
  return withTransaction(pool, async (client) => {
    const normalizedName = input.displayName.trim();
    const grantResult = await client.query<AccessGrantRow>(
      `select id, role, expires_at, revoked_at
         from document_access_grants
        where id = $1
          and doc_id = $2
          and (branch_id = $3 or branch_id is null)
        for update`,
      [input.grantId, input.docId, input.branchId],
    );
    const grant = grantResult.rows[0];
    if (!grant || !isUsable(grant) || grant.role !== 'edit') throw new Error('forbidden');

    const existing = await client.query<AccessSessionRow>(
      `update document_access_sessions
          set doc_id = $3,
              branch_id = $4,
              display_name = case when $5 <> '' then $5 else display_name end,
              last_branch_id = $4,
              last_seen_at = now()
        where grant_id = $1
          and client_id = $2
        returning id, grant_id, client_id, client_kind, display_name, color, last_branch_id, created_at, last_seen_at`,
      [input.grantId, input.clientId, input.docId, input.branchId, normalizedName],
    );
    const existingRow = existing.rows[0];
    if (existingRow) return sessionFromRow(existingRow);

    let displayName = normalizedName;
    if (!displayName) {
      const guests = await client.query<{ display_name: string }>(
        `select display_name
           from document_access_sessions
          where grant_id = $1
            and display_name like 'Guest %'
          for update`,
        [input.grantId],
      );
      displayName = nextGuestName(guests.rows);
    }

    const color = colorForSession(input.grantId, input.clientId);
    const inserted = await client.query<AccessSessionRow>(
      `insert into document_access_sessions
         (grant_id, doc_id, branch_id, client_id, client_kind, display_name, color, last_branch_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       returning id, grant_id, client_id, client_kind, display_name, color, last_branch_id, created_at, last_seen_at`,
      [input.grantId, input.docId, input.branchId, input.clientId, input.clientKind, displayName, color, input.branchId],
    );
    const insertedRow = inserted.rows[0];
    if (!insertedRow) throw new Error('access_session_insert_failed');
    return sessionFromRow(insertedRow);
  });
}

export async function recordDocumentAccessSession(pool: DbPool, input: {
  grantId?: string | null;
  docId: string;
  branchId: string;
  sessionId: string;
  clientKind: AccessClientKind;
  actorKind: AccessActorKind;
  actorId?: string | null;
  displayName: string;
}): Promise<void> {
  const color = colorForSession(input.grantId ?? input.docId, input.sessionId);
  // View-session audit identity is server-validated control-plane state, never client-authored Y.PermanentUserData.
  await pool.query(
    `insert into document_access_sessions
       (grant_id, doc_id, branch_id, client_id, client_kind, actor_kind, actor_id, display_name, color, last_branch_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     on conflict (grant_id, client_id) do update
       set doc_id = excluded.doc_id,
           branch_id = excluded.branch_id,
           client_kind = excluded.client_kind,
           actor_kind = excluded.actor_kind,
           actor_id = excluded.actor_id,
           display_name = excluded.display_name,
           color = excluded.color,
           last_branch_id = excluded.last_branch_id,
           last_seen_at = now()`,
    [
      input.grantId ?? null,
      input.docId,
      input.branchId,
      input.sessionId,
      input.clientKind,
      input.actorKind,
      input.actorId ?? null,
      input.displayName,
      color,
      input.branchId,
    ],
  );
}
