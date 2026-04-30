import type { DbPool } from '../db/client';
import type { AppliedLiveMarkdownTransaction, LiveMarkdownTransaction, LiveMarkdownWriter } from './live-writer';
import { createHeadlessMilkdownRuntime } from './milkdown-headless-runtime';
import { encodeYjsStateFingerprint } from './yjs-state-fingerprint';

export function createPostgresLiveMarkdownWriter(pool: DbPool): LiveMarkdownWriter {
  const runtime = createHeadlessMilkdownRuntime();

  return {
    async applyMarkdownTransaction(transaction: LiveMarkdownTransaction): Promise<AppliedLiveMarkdownTransaction> {
      const state = await pool.query<{
        yjs_state: Buffer;
        yjs_state_fingerprint?: string;
        current_markdown: string;
        current_hash: string;
      }>(
        `select yjs_state, yjs_state_fingerprint, current_markdown, current_hash
           from document_branch_states
          where branch_id = $1`,
        [transaction.branchId],
      );
      const row = state.rows[0];
      if (!row) throw new Error('branch_not_found');

      try {
        const applied = await runtime.applyChangedRanges({
          branchId: transaction.branchId,
          yjsState: new Uint8Array(row.yjs_state),
          seedMarkdown: row.current_markdown,
          targetCanonicalMarkdown: transaction.targetCanonicalMarkdown,
        });
        return {
          ...applied,
          sourceStateFingerprint: row.yjs_state_fingerprint ?? encodeYjsStateFingerprint(new Uint8Array(row.yjs_state)),
        };
      } catch {
        throw new Error('invalid_live_yjs_state');
      }
    },
  };
}
