import type { DbExecutor } from '../db/client';

export interface ReadBranchStateResult {
  docId: string;
  branchId: string;
  versionId: string;
  versionNumber: number;
  hash: string;
  markdown: string;
}

export async function readBranchState(
  pool: DbExecutor,
  docId: string,
  branchId: string,
): Promise<ReadBranchStateResult> {
  const result = await pool.query<{
    doc_id: string;
    branch_id: string;
    version_id: string;
    version_number: number;
    current_hash: string;
    current_markdown: string;
  }>(
    `select
       d.id as doc_id,
       b.id as branch_id,
       v.id as version_id,
       v.version_number,
       s.current_hash,
       s.current_markdown
     from documents d
     join document_branches b on b.doc_id = d.id
     join document_branch_states s on s.branch_id = b.id
     join document_versions v on v.id = b.head_version_id
     where d.id = $1 and b.id = $2 and b.is_archived = false`,
    [docId, branchId],
  );

  const row = result.rows[0];
  if (!row) throw new Error('branch_not_found');

  return {
    docId: row.doc_id,
    branchId: row.branch_id,
    versionId: row.version_id,
    versionNumber: row.version_number,
    hash: row.current_hash,
    markdown: row.current_markdown,
  };
}
