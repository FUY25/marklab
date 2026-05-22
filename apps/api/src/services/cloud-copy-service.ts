import type { DbExecutor, DbPool } from '../db/client';
import { withTransaction } from '../db/client';
import type { VersionActorType } from './version-service';

export interface DeleteCloudCopyInput {
  pool: DbPool;
  docId: string;
  branchId: string;
  actorType: VersionActorType;
  actorId?: string | undefined;
}

export interface DeleteCloudCopyResult {
  docId: string;
  branchIds: string[];
  providerDocIds: string[];
}

interface CloudCopyBranchRow {
  branch_id: string;
  provider_doc_id: string | null;
}

export async function isProviderDocDeleted(pool: DbExecutor, providerDocId: string): Promise<boolean> {
  const result = await pool.query(
    `select 1
       from provider_doc_deletions
      where provider_doc_id = $1
      limit 1`,
    [providerDocId],
  );
  return (result.rowCount ?? result.rows.length) > 0;
}

export async function deleteCloudCopy(input: DeleteCloudCopyInput): Promise<DeleteCloudCopyResult> {
  return withTransaction(input.pool, async (client) => {
    await client.query('set constraints all deferred');
    const branchResult = await client.query<CloudCopyBranchRow>(
      `select b.id as branch_id,
              s.provider_doc_id
         from documents d
         join document_branches b
           on b.doc_id = d.id
         left join document_branch_states s
           on s.branch_id = b.id
        where d.id = $1
          and exists (
            select 1
              from document_branches target
             where target.id = $2
               and target.doc_id = d.id
          )
        order by b.created_at asc`,
      [input.docId, input.branchId],
    );
    if (branchResult.rows.length === 0) throw new Error('branch_not_found');

    const branchIds = branchResult.rows.map((row) => row.branch_id);
    const providerDocIds = branchResult.rows
      .map((row) => row.provider_doc_id)
      .filter((value): value is string => Boolean(value));

    await client.query(
      `update document_access_grants
          set revoked_at = coalesce(revoked_at, now())
        where doc_id = $1`,
      [input.docId],
    );
    await client.query(
      `update collab_sessions
          set status = 'closed',
              expires_at = least(coalesce(expires_at, now()), now()),
              last_seen_at = now()
        where doc_id = $1
          and status = 'active'`,
      [input.docId],
    );
    await client.query(
      `update provider_token_issuances
          set status = 'revoked',
              provider_error = 'cloud_copy_deleted'
        where doc_id = $1
          and status in ('pending', 'issued')`,
      [input.docId],
    );

    for (const row of branchResult.rows) {
      if (!row.provider_doc_id) continue;
      await client.query(
        `insert into provider_doc_deletions
           (doc_id, branch_id, provider_doc_id, deleted_by_actor_type, deleted_by_actor_id)
         values ($1, $2, $3, $4, $5)
         on conflict (provider_doc_id) do update
           set cleanup_status = 'pending',
               deleted_by_actor_type = excluded.deleted_by_actor_type,
               deleted_by_actor_id = excluded.deleted_by_actor_id`,
        [input.docId, row.branch_id, row.provider_doc_id, input.actorType, input.actorId ?? null],
      );
    }

    await client.query(
      `delete from provider_token_refreshes
        where session_id in (
          select id from collab_sessions where doc_id = $1
        )`,
      [input.docId],
    );
    await client.query(
      `delete from provider_token_issuances
        where doc_id = $1`,
      [input.docId],
    );
    await client.query(
      `delete from document_access_sessions
        where doc_id = $1`,
      [input.docId],
    );
    await client.query(
      `delete from collab_sessions
        where doc_id = $1`,
      [input.docId],
    );
    await client.query(
      `update documents
          set default_branch_id = null
        where id = $1`,
      [input.docId],
    );
    await client.query(
      `update document_branches
          set head_version_id = null,
              created_from_version_id = null
        where doc_id = $1`,
      [input.docId],
    );
    await client.query(
      `update document_versions
          set parent_version_id = null
        where doc_id = $1`,
      [input.docId],
    );
    const deleted = await client.query<{ id: string }>(
      `delete from documents
        where id = $1
        returning id`,
      [input.docId],
    );
    if (!deleted.rows[0]) throw new Error('document_not_found');

    return { docId: input.docId, branchIds, providerDocIds };
  });
}
