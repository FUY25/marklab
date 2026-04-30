import { canonicalizeMarkdown } from '@marklab/markdown/src/canonicalize';
import { sha256Hex } from '@marklab/shared/src/hash';
import type { DbPool, DbTransactionClient } from '../db/client';
import { withTransaction } from '../db/client';
import type { LiveMarkdownOperation, LiveMarkdownTransaction, LiveMarkdownWriter } from './live-writer';
import { shouldCreateVersionForCurrentHash } from './save-policy';
import { createVersionWithClient, type VersionActorType } from './version-service';

export interface ApplyMarkdownToBranchInput {
  pool: DbPool;
  liveWriter: LiveMarkdownWriter;
  docId: string;
  branchId: string;
  parentVersionId: string;
  markdown: string;
  operation: LiveMarkdownOperation;
  actorType: VersionActorType;
  actorId?: string | undefined;
}

export interface ApplyMarkdownToBranchResult {
  canonicalMarkdown: string;
  hash: string;
  versionId: string;
  versionNumber: number;
}

function versionOperationForLiveOperation(operation: LiveMarkdownOperation): 'write' | 'edit' {
  switch (operation.kind) {
    case 'write':
      return 'write';
    case 'edit':
      return 'edit';
  }
}

interface BranchVersionState {
  currentMarkdown: string;
  currentHash: string;
  headVersionId: string;
  headHash: string;
}

async function readBranchVersionStateForUpdate(
  client: DbTransactionClient,
  branchId: string,
): Promise<BranchVersionState> {
  const result = await client.query<{
    current_markdown: string;
    current_hash: string;
    head_version_id: string | null;
    head_hash: string | null;
  }>(
    `select s.current_markdown,
            s.current_hash,
            b.head_version_id,
            v.hash as head_hash
       from document_branches b
       join document_branch_states s on s.branch_id = b.id
       left join document_versions v on v.id = b.head_version_id
      where b.id = $1 and b.is_archived = false
      for update of b, s`,
    [branchId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('branch_not_found');
  if (!row.head_version_id || !row.head_hash) throw new Error('branch_head_not_found');

  return {
    currentMarkdown: row.current_markdown,
    currentHash: row.current_hash,
    headVersionId: row.head_version_id,
    headHash: row.head_hash,
  };
}

async function createPreAgentCheckpointIfNeeded(
  client: DbTransactionClient,
  input: ApplyMarkdownToBranchInput,
): Promise<string> {
  const branchState = await readBranchVersionStateForUpdate(client, input.branchId);
  if (!shouldCreateVersionForCurrentHash(branchState.currentHash, branchState.headHash)) {
    return branchState.headVersionId;
  }

  const checkpoint = await createVersionWithClient({
    client,
    docId: input.docId,
    branchId: input.branchId,
    parentVersionId: branchState.headVersionId,
    markdown: branchState.currentMarkdown,
    hash: branchState.currentHash,
    actorType: 'system',
    operation: 'autosave',
  });

  return checkpoint.versionId;
}

export async function applyMarkdownToBranchState(
  input: ApplyMarkdownToBranchInput,
): Promise<ApplyMarkdownToBranchResult> {
  const requestedMarkdown = await canonicalizeMarkdown(input.markdown);
  const transaction: LiveMarkdownTransaction = {
    branchId: input.branchId,
    targetCanonicalMarkdown: requestedMarkdown,
    operation: input.operation,
  };
  const liveTransaction = await input.liveWriter.applyMarkdownTransaction(transaction);
  const canonicalMarkdown = await canonicalizeMarkdown(liveTransaction.serializedMarkdown);
  const hash = sha256Hex(canonicalMarkdown);
  if (liveTransaction.yjsState.byteLength === 0) throw new Error('invalid_live_yjs_state');

  const version = await withTransaction(input.pool, async (client) => {
    const parentVersionId = await createPreAgentCheckpointIfNeeded(client, input);
    const updateResult = await client.query(
      `update document_branch_states
          set current_markdown = $2,
              current_hash = $3,
              yjs_state = $4,
              updated_at = now()
        where branch_id = $1`,
      [input.branchId, canonicalMarkdown, hash, Buffer.from(liveTransaction.yjsState)],
    );

    if ((updateResult.rowCount ?? 1) === 0) throw new Error('branch_not_found');

    return createVersionWithClient({
      client,
      docId: input.docId,
      branchId: input.branchId,
      parentVersionId,
      markdown: canonicalMarkdown,
      hash,
      actorType: input.actorType,
      actorId: input.actorId,
      operation: versionOperationForLiveOperation(input.operation),
    });
  });

  return { canonicalMarkdown, hash, ...version };
}
