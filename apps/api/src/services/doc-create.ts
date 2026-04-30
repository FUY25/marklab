import type { DbPool } from '../db/client';
import { withTransaction } from '../db/client';
import { initializeBranchEditorState } from './milkdown-transformer';

export interface CreateDocInput {
  pool: DbPool;
  title: string;
  markdown: string;
  operation: 'create' | 'import';
}

export interface CreateDocResult {
  docId: string;
  branchId: string;
  versionId: string;
  hash: string;
}

function requiredId(value: string | undefined, label: string): string {
  if (!value) throw new Error(`${label}_insert_failed`);
  return value;
}

export async function createDoc(input: CreateDocInput): Promise<CreateDocResult> {
  const initialized = await initializeBranchEditorState(input.markdown);

  return withTransaction(input.pool, async (client) => {
    const doc = await client.query<{ id: string }>('insert into documents (title) values ($1) returning id', [
      input.title,
    ]);
    const docId = requiredId(doc.rows[0]?.id, 'document');

    const branch = await client.query<{ id: string }>(
      `insert into document_branches (doc_id, name, slug)
       values ($1, 'Main', 'main')
       returning id`,
      [docId],
    );
    const branchId = requiredId(branch.rows[0]?.id, 'document_branch');

    await client.query(
      `insert into document_branch_states (branch_id, yjs_state, current_markdown, current_hash)
       values ($1, $2, $3, $4)`,
      [branchId, Buffer.from(initialized.yjsState), initialized.markdown, initialized.hash],
    );

    const version = await client.query<{ id: string }>(
      `insert into document_versions
         (doc_id, branch_id, version_number, markdown_snapshot, hash, actor_type, operation)
       values ($1, $2, 1, $3, $4, 'user', $5)
       returning id`,
      [docId, branchId, initialized.markdown, initialized.hash, input.operation],
    );
    const versionId = requiredId(version.rows[0]?.id, 'document_version');

    await client.query(
      `update document_branches
          set head_version_id = $2
        where id = $1`,
      [branchId, versionId],
    );
    await client.query(
      `update documents
          set default_branch_id = $2,
              updated_at = now()
        where id = $1`,
      [docId, branchId],
    );

    return { docId, branchId, versionId, hash: initialized.hash };
  });
}
