import { describe, expect, it } from 'vitest';
import { canonicalizeMarkdown } from '@marklab/markdown/src/canonicalize';
import { sha256Hex } from '@marklab/shared/src/hash';
import * as Y from 'yjs';
import type { DbPool, DbQueryResult, DbTransactionClient } from '../db/client';
import { createUnavailableLiveMarkdownWriter, type LiveMarkdownTransaction, type LiveMarkdownWriter } from './live-writer';
import { applyMarkdownToBranchState } from './editor-state';

interface CapturedQuery {
  sql: string;
  params?: readonly unknown[];
}

interface FakePoolOptions {
  currentMarkdown?: string;
  currentHash?: string;
  headVersionId?: string;
  headHash?: string;
}

function createFakePool(options: FakePoolOptions = {}) {
  const queries: CapturedQuery[] = [];
  const versionIds = ['ver_002', 'ver_003'];
  let nextVersionNumber = 2;

  const query: DbPool['query'] = async <Row = unknown>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<DbQueryResult<Row>> => {
    queries.push(params === undefined ? { sql } : { sql, params });

    if (sql.includes('from document_branches b') && sql.includes('document_branch_states')) {
      return {
        rows: [
          {
            current_markdown: options.currentMarkdown ?? '# Current\n',
            current_hash: options.currentHash ?? 'sha256:head',
            head_version_id: options.headVersionId ?? 'ver_001',
            head_hash: options.headHash ?? options.currentHash ?? 'sha256:head',
          } as Row,
        ],
        rowCount: 1,
      };
    }

    if (sql.includes('coalesce(max(version_number)')) {
      return { rows: [{ next_version_number: nextVersionNumber++ } as Row], rowCount: 1 };
    }

    if (sql.includes('insert into document_versions')) {
      return { rows: [{ id: versionIds.shift() ?? 'ver_next' } as Row], rowCount: 1 };
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
  yjsState = createValidYjsState(),
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

function createValidYjsState(): Uint8Array {
  const doc = new Y.Doc();
  doc.getText('prosemirror').insert(0, 'live state');
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

describe('applyMarkdownToBranchState', () => {
  it('persists the live writer serialized markdown and passes operation metadata', async () => {
    const { pool, queries } = createFakePool();
    const liveSerializedMarkdown = '## Serialized from live editor';
    const liveYjsState = createValidYjsState();
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

  it('creates a pre-agent checkpoint for dirty human state before the agent version', async () => {
    const { pool, queries } = createFakePool({
      currentMarkdown: '# Human draft\n',
      currentHash: 'sha256:dirty',
      headVersionId: 'ver_001',
      headHash: 'sha256:head',
    });
    const liveWriter = createCapturingLiveWriter('# Agent result\n');

    const result = await applyMarkdownToBranchState({
      pool,
      liveWriter,
      docId: 'doc_001',
      branchId: 'br_main',
      parentVersionId: 'ver_001',
      markdown: '# Agent result\n',
      operation: { kind: 'write', baseVersionId: 'ver_001', baseHash: 'sha256:dirty' },
      actorType: 'agent',
    });

    const expectedAgentMarkdown = await canonicalizeMarkdown('# Agent result\n');
    const expectedAgentHash = sha256Hex(expectedAgentMarkdown);
    const versionInserts = queries.filter((query) => query.sql.includes('insert into document_versions'));

    expect(versionInserts.map((query) => query.params)).toEqual([
      ['doc_001', 'br_main', 'ver_001', 2, '# Human draft\n', 'sha256:dirty', 'system', null, 'autosave'],
      ['doc_001', 'br_main', 'ver_002', 3, expectedAgentMarkdown, expectedAgentHash, 'agent', null, 'write'],
    ]);
    expect(result).toMatchObject({ versionId: 'ver_003', versionNumber: 3, hash: expectedAgentHash });
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
  });

  it('does not persist mirror or version state when the live writer returns invalid yjs bytes', async () => {
    const { pool, queries } = createFakePool();
    const liveWriter = createCapturingLiveWriter('# Live result\n', new Uint8Array([1, 2, 3]));

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
    ).rejects.toThrow('invalid_live_yjs_state');

    expect(queries.some((query) => query.sql.includes('update document_branch_states'))).toBe(false);
    expect(queries.some((query) => query.sql.includes('insert into document_versions'))).toBe(false);
  });

  it('does not checkpoint dirty branch state when the live writer fails', async () => {
    const { pool, queries } = createFakePool({
      currentMarkdown: '# Human draft\n',
      currentHash: 'sha256:dirty',
      headVersionId: 'ver_001',
      headHash: 'sha256:head',
    });
    const liveWriter = createUnavailableLiveMarkdownWriter();

    await expect(
      applyMarkdownToBranchState({
        pool,
        liveWriter,
        docId: 'doc_001',
        branchId: 'br_main',
        parentVersionId: 'ver_001',
        markdown: '# Requested target',
        operation: { kind: 'write', baseVersionId: 'ver_001', baseHash: 'sha256:dirty' },
        actorType: 'agent',
      }),
    ).rejects.toThrow('live_writer_not_configured');

    expect(queries.some((query) => query.sql.includes('update document_branch_states'))).toBe(false);
    expect(queries.some((query) => query.sql.includes('insert into document_versions'))).toBe(false);
    expect(queries.some((query) => query.sql.includes('update document_branches'))).toBe(false);
  });
});
