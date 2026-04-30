import { canonicalizeMarkdown } from '@marklab/markdown/src/canonicalize';
import { sha256Hex } from '@marklab/shared/src/hash';
import type { DbPool } from '../db/client';
import { withTransaction } from '../db/client';
import type { LiveMarkdownOperation, LiveMarkdownTransaction, LiveMarkdownWriter } from './live-writer';
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
      parentVersionId: input.parentVersionId,
      markdown: canonicalMarkdown,
      hash,
      actorType: input.actorType,
      actorId: input.actorId,
      operation: versionOperationForLiveOperation(input.operation),
    });
  });

  return { canonicalMarkdown, hash, ...version };
}
