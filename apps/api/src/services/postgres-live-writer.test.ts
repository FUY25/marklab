import { describe, expect, it } from 'vitest';
import type { DbPool, DbQueryResult } from '../db/client';
import { createHeadlessMilkdownRuntime } from './milkdown-headless-runtime';
import { createPostgresLiveMarkdownWriter } from './postgres-live-writer';

function createPoolWithBranchState(input: { yjsState: Uint8Array; markdown: string; hash: string }) {
  const queries: { sql: string; params?: readonly unknown[] }[] = [];
  const pool: DbPool = {
    async query<Row = unknown>(sql: string, params?: readonly unknown[]): Promise<DbQueryResult<Row>> {
      queries.push(params ? { sql, params } : { sql });
      if (sql.includes('from document_branch_states')) {
        return {
          rows: [
            {
              yjs_state: Buffer.from(input.yjsState),
              current_markdown: input.markdown,
              current_hash: input.hash,
            } as Row,
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
    async connect() {
      throw new Error('connect_not_used_by_writer');
    },
  };
  return { pool, queries };
}

describe('createPostgresLiveMarkdownWriter', () => {
  const runtime = createHeadlessMilkdownRuntime();

  it('applies target markdown through live Yjs state and returns non-empty encoded state', async () => {
    const seeded = await runtime.initializeFromMarkdown('# Original\n\nKeep\n');
    const { pool } = createPoolWithBranchState(seeded);
    const writer = createPostgresLiveMarkdownWriter(pool);

    const applied = await writer.applyMarkdownTransaction({
      branchId: 'br_main',
      targetCanonicalMarkdown: '# Original\n\nChanged\n',
      operation: { kind: 'write', baseVersionId: 'ver_001', baseHash: seeded.hash },
    });

    expect(applied.serializedMarkdown).toContain('Changed');
    expect(applied.yjsState.byteLength).toBeGreaterThan(0);
    expect(applied.changedRangeCount).toBeGreaterThan(0);
    expect(applied.appliedTransactionCount).toBeGreaterThan(0);
  });

  it('seeds an empty live document from current_markdown before applying target markdown', async () => {
    const blank = await runtime.initializeFromMarkdown('');
    const { pool } = createPoolWithBranchState({
      yjsState: blank.yjsState,
      markdown: '# Imported before browser open\n\nOld\n',
      hash: blank.hash,
    });
    const writer = createPostgresLiveMarkdownWriter(pool);

    const applied = await writer.applyMarkdownTransaction({
      branchId: 'br_imported',
      targetCanonicalMarkdown: '# Imported before browser open\n\nNew\n',
      operation: { kind: 'edit', oldString: 'Old', newString: 'New', replaceAll: false },
    });

    expect(applied.serializedMarkdown).toContain('Imported before browser open');
    expect(applied.serializedMarkdown).toContain('New');
    expect(applied.yjsState.byteLength).toBeGreaterThan(0);
  });
});
