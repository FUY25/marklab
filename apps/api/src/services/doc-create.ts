import type { DbPool } from '../db/client';
import { withTransaction } from '../db/client';
import { initializeBranchEditorState } from './milkdown-transformer';
import type { VersionActorType } from './version-service';
import { encodeYjsStateFingerprint } from './yjs-state-fingerprint';

export interface CreateDocInput {
  pool: DbPool;
  title: string;
  markdown: string;
  operation: 'create' | 'import';
  actorType: VersionActorType;
  actorId?: string | undefined;
  ownerUserId?: string | undefined;
  workspaceId?: string | undefined;
  folderId?: string | undefined;
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
    const doc = await client.query<{ id: string }>(
      `insert into documents
         (title, owner_id, workspace_id, folder_id)
       values ($1, $2, $3, $4)
      returning id`,
      [
        input.title,
        input.ownerUserId ?? null,
        input.workspaceId ?? null,
        input.folderId ?? null,
      ],
    );
    const docId = requiredId(doc.rows[0]?.id, 'document');

    const branch = await client.query<{ id: string }>(
      `insert into document_branches (doc_id, name, slug)
       values ($1, 'Main', 'main')
       returning id`,
      [docId],
    );
    const branchId = requiredId(branch.rows[0]?.id, 'document_branch');

    await client.query(
      `insert into document_branch_states (branch_id, yjs_state, yjs_state_fingerprint, current_markdown, current_hash)
       values ($1, $2, $3, $4, $5)`,
      [
        branchId,
        Buffer.from(initialized.yjsState),
        encodeYjsStateFingerprint(initialized.yjsState),
        initialized.markdown,
        initialized.hash,
      ],
    );

    const version = await client.query<{ id: string }>(
      `insert into document_versions
         (doc_id, branch_id, version_number, markdown_snapshot, hash, actor_type, actor_id, operation)
       values ($1, $2, 1, $3, $4, $5, $6, $7)
       returning id`,
      [docId, branchId, initialized.markdown, initialized.hash, input.actorType, input.actorId ?? null, input.operation],
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
