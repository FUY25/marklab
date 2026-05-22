import { sha256Hex } from '@marklab/shared/src/hash';
import type { DbExecutor, DbPool } from '../db/client';
import { withTransaction } from '../db/client';
import { initializeBranchEditorState } from './milkdown-transformer';
import { shouldCreateAutosaveVersion } from './save-policy';
import { encodeYjsStateFingerprint } from './yjs-state-fingerprint';

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

export interface PersistBranchMarkdownSnapshotInput {
  pool: DbPool;
  docId: string;
  branchId: string;
  markdown: string;
  hash: string;
  yjsState?: Uint8Array | undefined;
  actorType: VersionActorType;
  actorId?: string | undefined;
  operation: Extract<VersionOperation, 'autosave' | 'manual_save'>;
}

export interface PersistBranchMarkdownSnapshotResult {
  branchId: string;
  markdown: string;
  hash: string;
  versionId: string;
  versionNumber: number;
  createdVersion: boolean;
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
  // Version audit identity must be passed from validated control-plane state, never from client-authored Y.PermanentUserData.
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

export async function persistBranchMarkdownSnapshot(
  input: PersistBranchMarkdownSnapshotInput,
): Promise<PersistBranchMarkdownSnapshotResult> {
  if (sha256Hex(input.markdown) !== input.hash) throw new Error('invalid_live_yjs_state');

  return withTransaction(input.pool, async (client) => {
    const state = await client.query<{
      head_version_id: string | null;
      head_version_number: number | null;
      head_hash: string | null;
    }>(
      `select b.head_version_id,
              v.version_number as head_version_number,
              v.hash as head_hash
         from document_branches b
         join document_branch_states s on s.branch_id = b.id
         join document_versions v on v.id = b.head_version_id
        where b.doc_id = $1 and b.id = $2 and b.is_archived = false
        for update of b, s`,
      [input.docId, input.branchId],
    );
    const row = state.rows[0];
    if (!row) throw new Error('branch_not_found');
    if (!row.head_version_id || !row.head_version_number || !row.head_hash) throw new Error('branch_head_not_found');

    const yjsState = input.yjsState;
    const update = yjsState
      ? await client.query(
          `update document_branch_states
              set current_markdown = $2,
                  current_hash = $3,
                  yjs_state = $4,
                  yjs_state_fingerprint = $5,
                  updated_at = now()
            where branch_id = $1`,
          [input.branchId, input.markdown, input.hash, Buffer.from(yjsState), encodeYjsStateFingerprint(yjsState)],
        )
      : await client.query(
          `update document_branch_states
              set current_markdown = $2,
                  current_hash = $3,
                  updated_at = now()
            where branch_id = $1`,
          [input.branchId, input.markdown, input.hash],
        );
    if ((update.rowCount ?? 1) === 0) throw new Error('branch_not_found');

    if (input.hash === row.head_hash) {
      return {
        branchId: input.branchId,
        markdown: input.markdown,
        hash: input.hash,
        versionId: row.head_version_id,
        versionNumber: row.head_version_number,
        createdVersion: false,
      };
    }

    if (input.operation === 'autosave') {
      const autosave = await client.query<{ last_autosave_at: Date | string | null }>(
        `select max(created_at) as last_autosave_at
           from document_versions
          where branch_id = $1
            and operation = 'autosave'`,
        [input.branchId],
      );
      const lastAutosaveAt = autosave.rows[0]?.last_autosave_at;
      if (
        !shouldCreateAutosaveVersion({
          currentHash: input.hash,
          headHash: row.head_hash,
          lastAutosaveAt: lastAutosaveAt ? new Date(lastAutosaveAt) : null,
          now: new Date(),
        })
      ) {
        return {
          branchId: input.branchId,
          markdown: input.markdown,
          hash: input.hash,
          versionId: row.head_version_id,
          versionNumber: row.head_version_number,
          createdVersion: false,
        };
      }
    }

    const version = await createVersionWithClient({
      client,
      docId: input.docId,
      branchId: input.branchId,
      parentVersionId: row.head_version_id,
      markdown: input.markdown,
      hash: input.hash,
      actorType: input.actorType,
      actorId: input.actorId,
      operation: input.operation,
    });

    return {
      branchId: input.branchId,
      markdown: input.markdown,
      hash: input.hash,
      versionId: version.versionId,
      versionNumber: version.versionNumber,
      createdVersion: true,
    };
  });
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export async function getDocumentSummary(pool: DbExecutor, docId: string) {
  const result = await pool.query<{
    id: string;
    title: string;
    default_branch_id: string | null;
  }>(
    `select d.id, d.title, d.default_branch_id
       from documents d
      where d.id = $1`,
    [docId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('document_not_found');

  return { docId: row.id, title: row.title, defaultBranchId: row.default_branch_id };
}

export async function listBranches(pool: DbExecutor, docId: string) {
  const result = await pool.query<{
    id: string;
    name: string;
    slug: string;
    head_version_id: string | null;
    created_from_version_id: string | null;
    is_archived: boolean;
    version_number: number | null;
  }>(
    `select b.id, b.name, b.slug, b.head_version_id, b.created_from_version_id, b.is_archived, v.version_number
       from document_branches b
       left join document_versions v on v.id = b.head_version_id
      where b.doc_id = $1
      order by b.created_at asc`,
    [docId],
  );

  return result.rows.map((row) => ({
    branchId: row.id,
    name: row.name,
    slug: row.slug,
    headVersionId: row.head_version_id,
    createdFromVersionId: row.created_from_version_id,
    isArchived: row.is_archived,
    headVersionNumber: row.version_number,
  }));
}

export async function listVersions(pool: DbExecutor, docId: string, branchId: string) {
  const result = await pool.query<{
    id: string;
    parent_version_id: string | null;
    version_number: number;
    hash: string;
    actor_type: VersionActorType;
    actor_id: string | null;
    operation: VersionOperation;
    created_at: Date | string;
  }>(
    `select id, parent_version_id, version_number, hash, actor_type, actor_id, operation, created_at
       from document_versions
      where doc_id = $1 and branch_id = $2
      order by version_number desc`,
    [docId, branchId],
  );

  return result.rows.map((row) => ({
    versionId: row.id,
    parentVersionId: row.parent_version_id,
    versionNumber: row.version_number,
    hash: row.hash,
    actorType: row.actor_type,
    actorId: row.actor_id,
    operation: row.operation,
    createdAt: toIsoString(row.created_at),
  }));
}

export async function showVersion(pool: DbExecutor, docId: string, versionId: string) {
  const result = await pool.query<{
    id: string;
    branch_id: string;
    parent_version_id: string | null;
    version_number: number;
    markdown_snapshot: string;
    hash: string;
    actor_type: VersionActorType;
    actor_id: string | null;
    operation: VersionOperation;
    created_at: Date | string;
  }>(
    `select id, branch_id, parent_version_id, version_number, markdown_snapshot, hash, actor_type, actor_id, operation, created_at
       from document_versions
      where doc_id = $1 and id = $2`,
    [docId, versionId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('version_not_found');

  return {
    versionId: row.id,
    branchId: row.branch_id,
    parentVersionId: row.parent_version_id,
    versionNumber: row.version_number,
    markdown: row.markdown_snapshot,
    hash: row.hash,
    actorType: row.actor_type,
    actorId: row.actor_id,
    operation: row.operation,
    createdAt: toIsoString(row.created_at),
  };
}

export async function branchFromVersion(
  pool: DbPool,
  docId: string,
  sourceVersionId: string,
  branchName: string,
  branchSlug: string,
) {
  return withTransaction(pool, async (client) => {
    const source = await client.query<{ markdown_snapshot: string; hash: string }>(
      `select markdown_snapshot, hash
         from document_versions
        where id = $1 and doc_id = $2`,
      [sourceVersionId, docId],
    );
    const sourceRow = source.rows[0];
    if (!sourceRow) throw new Error('source_version_not_found');

    const branch = await client.query<{ id: string }>(
      `insert into document_branches (doc_id, name, slug, created_from_version_id)
       values ($1, $2, $3, $4)
       returning id`,
      [docId, branchName, branchSlug, sourceVersionId],
    );
    const branchId = branch.rows[0]?.id;
    if (!branchId) throw new Error('document_branch_insert_failed');

    const initialized = await initializeBranchEditorState(sourceRow.markdown_snapshot);

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
        (doc_id, branch_id, parent_version_id, version_number, markdown_snapshot, hash, actor_type, operation)
       values ($1, $2, $3, 1, $4, $5, 'system', 'branch')
       returning id`,
      [docId, branchId, sourceVersionId, initialized.markdown, initialized.hash],
    );
    const versionId = version.rows[0]?.id;
    if (!versionId) throw new Error('document_version_insert_failed');

    await client.query(
      `update document_branches
          set head_version_id = $2
        where id = $1`,
      [branchId, versionId],
    );

    return { branchId, versionId };
  });
}
