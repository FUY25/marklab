import { describe, expect, it } from 'vitest';
import type { DbPool, DbQueryResult, DbTransactionClient } from '../db/client';
import { createHeadlessMilkdownRuntime } from './milkdown-headless-runtime';
import { flushBranchMarkdownMirror } from './milkdown-transformer';

interface CapturedQuery {
  sql: string;
  params?: readonly unknown[];
}

function createFlushPool(input: { yjsState: Uint8Array; headHash: string }) {
  const queries: CapturedQuery[] = [];

  const query: DbPool['query'] = async <Row = unknown>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<DbQueryResult<Row>> => {
    queries.push(params === undefined ? { sql } : { sql, params });

    if (sql.includes('from document_branches b') && sql.includes('document_branch_states')) {
      return {
        rows: [
          {
            yjs_state: Buffer.from(input.yjsState),
            yjs_state_fingerprint: 'state-fingerprint',
            head_version_id: 'ver_001',
            head_version_number: 1,
            head_hash: input.headHash,
          } as Row,
        ],
        rowCount: 1,
      };
    }

    if (sql.includes('coalesce(max(version_number)')) {
      return { rows: [{ next_version_number: 2 } as Row], rowCount: 1 };
    }

    if (sql.includes('insert into document_versions')) {
      return { rows: [{ id: 'ver_002' } as Row], rowCount: 1 };
    }

    return { rows: [], rowCount: 1 };
  };

  const client: DbTransactionClient = {
    query,
    release: () => undefined,
  };
  const pool: DbPool = {
    query,
    connect: async () => client,
  };

  return { pool, queries };
}

describe('milkdown transformer', () => {
  it('returns existing head version metadata when flushed live state is already versioned', async () => {
    const runtime = createHeadlessMilkdownRuntime();
    const seeded = await runtime.initializeFromMarkdown('# Clean live\n');
    const { pool, queries } = createFlushPool({
      yjsState: seeded.yjsState,
      headHash: seeded.hash,
    });

    const result = await flushBranchMarkdownMirror(pool, 'doc_001', 'br_main', 'autosave');

    expect(result).toEqual({
      branchId: 'br_main',
      markdown: seeded.markdown,
      hash: seeded.hash,
      versionId: 'ver_001',
      versionNumber: 1,
      createdVersion: false,
    });
    expect(queries.some((query) => query.sql.includes('insert into document_versions'))).toBe(false);
  });

  it('fails closed when persisted live Yjs state cannot be decoded', async () => {
    const { pool, queries } = createFlushPool({
      yjsState: new Uint8Array([1, 2, 3]),
      headHash: 'sha256:head',
    });

    await expect(flushBranchMarkdownMirror(pool, 'doc_001', 'br_main', 'autosave')).rejects.toThrow(
      'invalid_live_yjs_state',
    );

    expect(queries.some((query) => query.sql.includes('update document_branch_states'))).toBe(false);
    expect(queries.some((query) => query.sql.includes('insert into document_versions'))).toBe(false);
  });
});
