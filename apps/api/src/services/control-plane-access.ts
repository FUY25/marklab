import type { DbExecutor } from '../db/client';
import type { AccessOperation, AccessGrantRole, VerifiedDocumentAccess } from './access-control';

export type WorkspaceRole = 'Owner' | 'Member' | 'Reader';

interface DocumentMembershipRow {
  owner_id: string | null;
  workspace_id: string | null;
  member_role: WorkspaceRole | null;
}

function canRead(row: DocumentMembershipRow, userId: string): boolean {
  if (row.workspace_id) return row.member_role === 'Owner' || row.member_role === 'Member' || row.member_role === 'Reader';
  return row.owner_id === userId || row.member_role === 'Owner' || row.member_role === 'Member' || row.member_role === 'Reader';
}

function canWrite(row: DocumentMembershipRow, userId: string): boolean {
  if (row.workspace_id) return row.member_role === 'Owner' || row.member_role === 'Member';
  return row.owner_id === userId || row.member_role === 'Owner' || row.member_role === 'Member';
}

function roleFor(row: DocumentMembershipRow, userId: string): AccessGrantRole {
  return canWrite(row, userId) ? 'edit' : 'view';
}

export async function requireUserDocumentAccess(pool: DbExecutor, input: {
  userId: string;
  docId: string;
  branchId: string;
  operation: AccessOperation;
}): Promise<VerifiedDocumentAccess> {
  const result = await pool.query<DocumentMembershipRow>(
    `select d.owner_id,
            d.workspace_id,
            m.role as member_role
       from documents d
       join document_branches b
         on b.doc_id = d.id
        and b.id = $3
        and b.is_archived = false
       left join workspace_members m
         on m.workspace_id = d.workspace_id
        and m.user_id = $1
      where d.id = $2`,
    [input.userId, input.docId, input.branchId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('forbidden');
  if (input.operation === 'read' && canRead(row, input.userId)) {
    return { actorType: 'user', actorId: input.userId, canManageAccess: row.workspace_id ? row.member_role === 'Owner' : row.owner_id === input.userId, role: roleFor(row, input.userId) };
  }
  if (input.operation === 'write' && canWrite(row, input.userId)) {
    return { actorType: 'user', actorId: input.userId, canManageAccess: row.workspace_id ? row.member_role === 'Owner' : row.owner_id === input.userId, role: 'edit' };
  }
  throw new Error('forbidden');
}

export async function requireWorkspaceRole(pool: DbExecutor, input: {
  workspaceId: string;
  userId: string;
  allowed: readonly WorkspaceRole[];
}): Promise<WorkspaceRole> {
  const result = await pool.query<{ role: WorkspaceRole }>(
    `select role
       from workspace_members
      where workspace_id = $1
        and user_id = $2`,
    [input.workspaceId, input.userId],
  );
  const role = result.rows[0]?.role;
  if (!role || !input.allowed.includes(role)) throw new Error('forbidden');
  return role;
}
