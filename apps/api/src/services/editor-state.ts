import { canonicalizeMarkdown } from '@mdcollab/markdown/src/canonicalize';
import { sha256Hex } from '@mdcollab/shared/src/hash';
import type { DbPool } from '../db/client';
import { withTransaction } from '../db/client';
import type { LiveMarkdownWriter } from './live-writer';
import { createVersionWithClient, type VersionActorType, type VersionOperation } from './version-service';

export type { LiveMarkdownWriter } from './live-writer';

export interface ApplyMarkdownToBranchInput {
  pool: DbPool;
  liveWriter: LiveMarkdownWriter;
  docId: string;
  branchId: string;
  parentVersionId: string;
  markdown: string;
  operation: Extract<VersionOperation, 'write' | 'edit'>;
  actorType: VersionActorType;
  actorId?: string | undefined;
}

export interface ApplyMarkdownToBranchResult {
  canonicalMarkdown: string;
  hash: string;
  versionId: string;
  versionNumber: number;
}

export async function applyMarkdownToBranchState(
  input: ApplyMarkdownToBranchInput,
): Promise<ApplyMarkdownToBranchResult> {
  const requestedMarkdown = await canonicalizeMarkdown(input.markdown);
  const liveSerializedMarkdown = await input.liveWriter.replaceBranchMarkdown(input.branchId, requestedMarkdown);
  const canonicalMarkdown = await canonicalizeMarkdown(liveSerializedMarkdown);
  const hash = sha256Hex(canonicalMarkdown);

  const version = await withTransaction(input.pool, async (client) => {
    const updateResult = await client.query(
      `update document_branch_states
          set current_markdown = $2,
              current_hash = $3,
              updated_at = now()
        where branch_id = $1`,
      [input.branchId, canonicalMarkdown, hash],
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
      operation: input.operation,
    });
  });

  return { canonicalMarkdown, hash, ...version };
}
