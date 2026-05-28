import { toRoomName } from '../collab/persistence';
import type { DbPool } from '../db/client';

export interface RuntimeAccessConnectionClosers {
  closeCollabDocumentConnections?: ((roomName: string) => void) | undefined;
  closeProviderDocConnections?: ((providerDocIds: readonly string[]) => void) | undefined;
}

interface RuntimeBranchRow {
  doc_id: string;
  branch_id: string;
  provider_doc_id: string | null;
}

export async function closeDirectUserRuntimeAccess(
  pool: DbPool,
  closers: RuntimeAccessConnectionClosers,
  input: {
    userId: string;
    workspaceId?: string | null;
    providerError: string;
  },
): Promise<void> {
  const workspaceId = input.workspaceId ?? null;
  const branches = await pool.query<RuntimeBranchRow>(
    `select distinct s.doc_id,
            s.branch_id,
            state.provider_doc_id
       from collab_sessions s
       join documents d
         on d.id = s.doc_id
       left join document_branch_states state
         on state.branch_id = s.branch_id
      where s.actor_type = 'user'
        and s.actor_id = $1
        and s.actor_grant_id is null
        and s.mode = 'edit'
        and s.role = 'edit'
        and s.status = 'active'
        and ($2::uuid is null or d.workspace_id = $2::uuid)`,
    [input.userId, workspaceId],
  );

  await pool.query(
    `update collab_sessions s
        set status = 'closed',
            expires_at = least(coalesce(s.expires_at, now()), now()),
            last_seen_at = now()
       from documents d
      where d.id = s.doc_id
        and s.actor_type = 'user'
        and s.actor_id = $1
        and s.actor_grant_id is null
        and s.mode = 'edit'
        and s.role = 'edit'
        and s.status = 'active'
        and ($2::uuid is null or d.workspace_id = $2::uuid)`,
    [input.userId, workspaceId],
  );

  await pool.query(
    `update provider_token_issuances pti
        set status = 'revoked',
            provider_error = $3
       from documents d
      where d.id = pti.doc_id
        and pti.actor_type = 'user'
        and pti.actor_id = $1
        and pti.actor_grant_id is null
        and pti."authorization" = 'full'
        and pti.status in ('pending', 'issued')
        and ($2::uuid is null or d.workspace_id = $2::uuid)`,
    [input.userId, workspaceId, input.providerError],
  );

  for (const branch of branches.rows) {
    try {
      closers.closeCollabDocumentConnections?.(toRoomName(branch.doc_id, branch.branch_id));
    } catch {
      // Runtime socket cleanup is best effort; DB revocation is authoritative.
    }
  }

  const providerDocIds = [...new Set(branches.rows.map((row) => row.provider_doc_id).filter((value): value is string => Boolean(value)))];
  if (providerDocIds.length > 0) {
    try {
      closers.closeProviderDocConnections?.(providerDocIds);
    } catch {
      // Runtime socket cleanup is best effort; DB revocation is authoritative.
    }
  }
}
