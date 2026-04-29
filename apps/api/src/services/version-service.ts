import type { DbExecutor, DbPool } from '../db/client';
import { withTransaction } from '../db/client';

export type VersionActorType = 'agent' | 'user' | 'system';
export type VersionOperation = 'create' | 'import' | 'autosave' | 'manual_save' | 'write' | 'edit' | 'rollback' | 'branch';

export interface CreateVersionInput {
  pool: DbPool;
  docId: string;
  branchId: string;
  parentVersionId?: string | undefined;
  markdown: string;
  hash: string;
  actorType: VersionActorType;
  actorId?: string | undefined;
  operation: VersionOperation;
}

export interface CreateVersionWithClientInput extends Omit<CreateVersionInput, 'pool'> {
  client: DbExecutor;
}

export interface CreateVersionResult {
  versionId: string;
  versionNumber: number;
}

export async function nextVersionNumber(client: DbExecutor, branchId: string): Promise<number> {
  const result = await client.query<{ next_version_number: number | string }>(
    `select coalesce(max(version_number), 0) + 1 as next_version_number
       from document_versions
      where branch_id = $1`,
    [branchId],
  );
  const value = result.rows[0]?.next_version_number;
  if (value === undefined) return 1;
  return Number(value);
}

export async function createVersionWithClient(input: CreateVersionWithClientInput): Promise<CreateVersionResult> {
  const versionNumber = await nextVersionNumber(input.client, input.branchId);
  const actorId = input.actorId ?? null;
  const parentVersionId = input.parentVersionId ?? null;
  const insertResult = await input.client.query<{ id: string }>(
    `insert into document_versions
       (doc_id, branch_id, parent_version_id, version_number, markdown_snapshot, hash, actor_type, actor_id, operation)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     returning id`,
    [
      input.docId,
      input.branchId,
      parentVersionId,
      versionNumber,
      input.markdown,
      input.hash,
      input.actorType,
      actorId,
      input.operation,
    ],
  );
  const versionId = insertResult.rows[0]?.id;
  if (!versionId) throw new Error('version_insert_failed');

  await input.client.query(
    `update document_branches
        set head_version_id = $2
      where id = $1`,
    [input.branchId, versionId],
  );

  return { versionId, versionNumber };
}

export async function createVersion(input: CreateVersionInput): Promise<CreateVersionResult> {
  return withTransaction(input.pool, async (client) =>
    createVersionWithClient({
      client,
      docId: input.docId,
      branchId: input.branchId,
      parentVersionId: input.parentVersionId,
      markdown: input.markdown,
      hash: input.hash,
      actorType: input.actorType,
      actorId: input.actorId,
      operation: input.operation,
    }),
  );
}
