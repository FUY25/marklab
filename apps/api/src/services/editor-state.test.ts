import { describe, expect, it } from 'vitest';
import { canonicalizeMarkdown } from '@marklab/markdown/src/canonicalize';
import { sha256Hex } from '@marklab/shared/src/hash';
import type { DbPool, DbQueryResult, DbTransactionClient } from '../db/client';
import { createUnavailableLiveMarkdownWriter, type LiveMarkdownTransaction, type LiveMarkdownWriter } from './live-writer';
import { applyMarkdownToBranchState } from './editor-state';

interface CapturedQuery {
  sql: string;
  params?: readonly unknown[];
}

function createFakePool() {
  const queries: CapturedQuery[] = [];

  const query: DbPool['query'] = async <Row = unknown>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<DbQueryResult<Row>> => {
    queries.push(params === undefined ? { sql } : { sql, params });

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

function createCapturingLiveWriter(
  serializedMarkdown: string,
  yjsState = new Uint8Array([1, 2, 3]),
): LiveMarkdownWriter & {
  transactions: LiveMarkdownTransaction[];
} {
  const transactions: LiveMarkdownTransaction[] = [];
  return {
    transactions,
    async applyMarkdownTransaction(transaction) {
      transactions.push(transaction);
      return { serializedMarkdown, yjsState, changedRangeCount: 1, appliedTransactionCount: 1 };
    },
  };
}

describe('applyMarkdownToBranchState', () => {
  it('persists the live writer serialized markdown and passes operation metadata', async () => {
    const { pool, queries } = createFakePool();
    const liveSerializedMarkdown = '## Serialized from live editor';
    const liveYjsState = new Uint8Array([7, 8, 9]);
    const liveWriter = createCapturingLiveWriter(liveSerializedMarkdown, liveYjsState);

    const result = await applyMarkdownToBranchState({
      pool,
      liveWriter,
      docId: 'doc_001',
      branchId: 'br_main',
      parentVersionId: 'ver_001',
      markdown: '# Requested target',
      operation: {
        kind: 'edit',
        observedVersionId: 'ver_seen',
        oldString: 'Requested',
        newString: 'Serialized',
        replaceAll: false,
      },
      actorType: 'agent',
      actorId: 'agent_001',
    });

    const expectedMarkdown = await canonicalizeMarkdown(liveSerializedMarkdown);
    const expectedHash = sha256Hex(expectedMarkdown);

    expect(liveWriter.transactions).toEqual([
      {
        branchId: 'br_main',
        targetCanonicalMarkdown: '# Requested target\n',
        operation: {
          kind: 'edit',
          observedVersionId: 'ver_seen',
          oldString: 'Requested',
          newString: 'Serialized',
          replaceAll: false,
        },
      },
    ]);

    const branchStateUpdate = queries.find((query) => query.sql.includes('update document_branch_states'));
    expect(branchStateUpdate?.params).toEqual(['br_main', expectedMarkdown, expectedHash, Buffer.from(liveYjsState)]);

    const versionInsert = queries.find((query) => query.sql.includes('insert into document_versions'));
    expect(versionInsert?.params).toEqual([
      'doc_001',
      'br_main',
      'ver_001',
      2,
      expectedMarkdown,
      expectedHash,
      'agent',
      'agent_001',
      'edit',
    ]);

    expect(result).toEqual({
      canonicalMarkdown: expectedMarkdown,
      hash: expectedHash,
      versionId: 'ver_002',
      versionNumber: 2,
    });
  });

  it('does not persist mirror or version state when the live writer fails', async () => {
    const { pool, queries } = createFakePool();
    const liveWriter = createUnavailableLiveMarkdownWriter();

    await expect(
      applyMarkdownToBranchState({
        pool,
        liveWriter,
        docId: 'doc_001',
        branchId: 'br_main',
        parentVersionId: 'ver_001',
        markdown: '# Requested target',
        operation: { kind: 'write', baseVersionId: 'ver_001', baseHash: 'sha256:current' },
        actorType: 'agent',
      }),
    ).rejects.toThrow('live_writer_not_configured');

    expect(queries.some((query) => query.sql.includes('update document_branch_states'))).toBe(false);
    expect(queries.some((query) => query.sql.includes('insert into document_versions'))).toBe(false);
    expect(queries.some((query) => query.sql === 'begin')).toBe(false);
  });
});
