import { canonicalizeMarkdown } from '@marklab/markdown/src/canonicalize';
import { sha256Hex } from '@marklab/shared/src/hash';
import * as Y from 'yjs';
import type { DbPool, DbTransactionClient } from '../db/client';
import { withTransaction } from '../db/client';
import { applyEditToMarkdown, assertCanWrite } from './doc-write';
import type {
  AppliedLiveMarkdownTransaction,
  LiveMarkdownOperation,
  LiveMarkdownTransaction,
  LiveMarkdownWriter,
} from './live-writer';
import { shouldCreateVersionForCurrentHash } from './save-policy';
import { createVersionWithClient, type VersionActorType } from './version-service';
import { encodeYjsStateFingerprint } from './yjs-state-fingerprint';

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
  stateFingerprint: string;
}

async function readBranchVersionStateForUpdate(
  client: DbTransactionClient,
  branchId: string,
): Promise<BranchVersionState> {
  const result = await client.query<{
    current_markdown: string;
    current_hash: string;
    yjs_state: Buffer;
    yjs_state_fingerprint: string | null;
    head_version_id: string | null;
    head_hash: string | null;
  }>(
    `select s.current_markdown,
            s.current_hash,
            s.yjs_state,
            s.yjs_state_fingerprint,
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
    stateFingerprint: row.yjs_state_fingerprint ?? encodeYjsStateFingerprint(new Uint8Array(row.yjs_state)),
  };
}

async function expectedEditMarkdown(
  baseMarkdown: string,
  operation: Extract<LiveMarkdownOperation, { kind: 'edit' }>,
): Promise<string> {
  return canonicalizeMarkdown(
    applyEditToMarkdown(baseMarkdown, operation.oldString, operation.newString, operation.replaceAll),
  );
}

async function assertOperationStillApplies(
  branchState: BranchVersionState,
  input: ApplyMarkdownToBranchInput,
  liveTransaction: AppliedLiveMarkdownTransaction,
  targetCanonicalMarkdown: string,
): Promise<void> {
  if (input.operation.kind === 'write') {
    assertCanWrite(
      branchState.headVersionId,
      branchState.currentHash,
      input.operation.baseVersionId,
      input.operation.baseHash,
    );
    return;
  }

  const baseMarkdown = liveTransaction.previousSerializedMarkdown ?? branchState.currentMarkdown;
  const expectedMarkdown = await expectedEditMarkdown(baseMarkdown, input.operation);
  if (expectedMarkdown !== targetCanonicalMarkdown) throw new Error('live_yjs_state_changed');
}

async function createPreAgentCheckpointIfNeeded(
  client: DbTransactionClient,
  input: ApplyMarkdownToBranchInput,
  liveTransaction: AppliedLiveMarkdownTransaction,
  targetCanonicalMarkdown: string,
): Promise<string> {
  const branchState = await readBranchVersionStateForUpdate(client, input.branchId);
  if (liveTransaction.sourceStateFingerprint !== undefined && liveTransaction.sourceStateFingerprint !== branchState.stateFingerprint) {
    throw new Error('live_yjs_state_changed');
  }
  await assertOperationStillApplies(branchState, input, liveTransaction, targetCanonicalMarkdown);

  const checkpointMarkdown = liveTransaction.previousSerializedMarkdown ?? branchState.currentMarkdown;
  const checkpointHash = liveTransaction.previousHash ?? branchState.currentHash;

  if (!shouldCreateVersionForCurrentHash(checkpointHash, branchState.headHash)) {
    return branchState.headVersionId;
  }

  const checkpoint = await createVersionWithClient({
    client,
    docId: input.docId,
    branchId: input.branchId,
    parentVersionId: branchState.headVersionId,
    markdown: checkpointMarkdown,
    hash: checkpointHash,
    actorType: 'system',
    operation: 'autosave',
  });

  return checkpoint.versionId;
}

function assertValidLiveYjsState(yjsState: Uint8Array): void {
  if (yjsState.byteLength === 0) throw new Error('invalid_live_yjs_state');

  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, yjsState);
  } catch {
    throw new Error('invalid_live_yjs_state');
  } finally {
    doc.destroy();
  }
}

export async function applyMarkdownToBranchState(
  input: ApplyMarkdownToBranchInput,
): Promise<ApplyMarkdownToBranchResult> {
  let targetCanonicalMarkdown = await canonicalizeMarkdown(input.markdown);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const transaction: LiveMarkdownTransaction = {
      branchId: input.branchId,
      targetCanonicalMarkdown,
      operation: input.operation,
    };
    const liveTransaction = await input.liveWriter.applyMarkdownTransaction(transaction);
    assertValidLiveYjsState(liveTransaction.yjsState);

    if (input.operation.kind === 'edit' && liveTransaction.previousSerializedMarkdown !== undefined) {
      const rebasedMarkdown = await expectedEditMarkdown(liveTransaction.previousSerializedMarkdown, input.operation);
      if (rebasedMarkdown !== targetCanonicalMarkdown) {
        targetCanonicalMarkdown = rebasedMarkdown;
        continue;
      }
    }

    const canonicalMarkdown = await canonicalizeMarkdown(liveTransaction.serializedMarkdown);
    const hash = sha256Hex(canonicalMarkdown);
    const yjsStateFingerprint = encodeYjsStateFingerprint(liveTransaction.yjsState);

    try {
      const version = await withTransaction(input.pool, async (client) => {
        const parentVersionId = await createPreAgentCheckpointIfNeeded(
          client,
          input,
          liveTransaction,
          targetCanonicalMarkdown,
        );
        const updateResult = await client.query(
          `update document_branch_states
              set current_markdown = $2,
                  current_hash = $3,
                  yjs_state = $4,
                  yjs_state_fingerprint = $5,
                  updated_at = now()
            where branch_id = $1`,
          [input.branchId, canonicalMarkdown, hash, Buffer.from(liveTransaction.yjsState), yjsStateFingerprint],
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
    } catch (error) {
      if (error instanceof Error && error.message === 'live_yjs_state_changed' && attempt < 2) continue;
      throw error;
    }
  }

  throw new Error('live_yjs_state_changed');
}
