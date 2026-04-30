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
  stateFingerprints?: string[];
}

function createFakePool(options: FakePoolOptions = {}) {
  const queries: CapturedQuery[] = [];
  const versionIds = ['ver_002', 'ver_003'];
  let nextVersionNumber = 2;
  let branchStateReadCount = 0;

  const query: DbPool['query'] = async <Row = unknown>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<DbQueryResult<Row>> => {
    queries.push(params === undefined ? { sql } : { sql, params });

    if (sql.includes('from document_branches b') && sql.includes('document_branch_states')) {
      const stateFingerprints = options.stateFingerprints ?? ['101'];
      const stateFingerprint = stateFingerprints[Math.min(branchStateReadCount, stateFingerprints.length - 1)] ?? '101';
      branchStateReadCount += 1;
      return {
        rows: [
          {
            current_markdown: options.currentMarkdown ?? '# Current\n',
            current_hash: options.currentHash ?? 'sha256:head',
            yjs_state: Buffer.from(createValidYjsState()),
            head_version_id: options.headVersionId ?? 'ver_001',
            head_hash: options.headHash ?? options.currentHash ?? 'sha256:head',
            yjs_state_fingerprint: stateFingerprint,
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
      return {
        serializedMarkdown,
        yjsState,
        changedRangeCount: 1,
        changedCharacterCount: serializedMarkdown.length,
        documentCharacterCount: serializedMarkdown.length,
        fullDocumentReplacement: true,
        appliedTransactionCount: 1,
      };
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
      operation: { kind: 'write', baseVersionId: 'ver_001', baseHash: 'sha256:head' },
      actorType: 'agent',
      actorId: 'agent_001',
    });

    const expectedMarkdown = await canonicalizeMarkdown(liveSerializedMarkdown);
    const expectedHash = sha256Hex(expectedMarkdown);

    expect(liveWriter.transactions).toEqual([
      {
        branchId: 'br_main',
        targetCanonicalMarkdown: '# Requested target\n',
        operation: { kind: 'write', baseVersionId: 'ver_001', baseHash: 'sha256:head' },
      },
    ]);

    const branchStateUpdate = queries.find((query) => query.sql.includes('update document_branch_states'));
    expect(branchStateUpdate?.params).toEqual([
      'br_main',
      expectedMarkdown,
      expectedHash,
      Buffer.from(liveYjsState),
      expect.any(String),
    ]);

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
      'write',
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

  it('retries against fresh live state when Hocuspocus persists between writer read and API write', async () => {
    const { pool, queries } = createFakePool({ stateFingerprints: ['102', '102'] });
    const transactions: LiveMarkdownTransaction[] = [];
    let attempt = 0;
    const liveWriter: LiveMarkdownWriter = {
      async applyMarkdownTransaction(transaction) {
        transactions.push(transaction);
        attempt += 1;
        return {
          serializedMarkdown: '# Agent result\n',
          yjsState: createValidYjsState(),
          sourceStateFingerprint: attempt === 1 ? '101' : '102',
          previousSerializedMarkdown: '# Current\n',
          previousHash: 'sha256:head',
          changedRangeCount: 1,
          changedCharacterCount: '# Agent result\n'.length,
          documentCharacterCount: '# Agent result\n'.length,
          fullDocumentReplacement: true,
          appliedTransactionCount: 1,
        };
      },
    };

    const result = await applyMarkdownToBranchState({
      pool,
      liveWriter,
      docId: 'doc_001',
      branchId: 'br_main',
      parentVersionId: 'ver_001',
      markdown: '# Agent result\n',
      operation: { kind: 'write', baseVersionId: 'ver_001', baseHash: 'sha256:head' },
      actorType: 'agent',
    });

    const expectedAgentMarkdown = await canonicalizeMarkdown('# Agent result\n');
    const expectedAgentHash = sha256Hex(expectedAgentMarkdown);
    const versionInserts = queries.filter((query) => query.sql.includes('insert into document_versions'));
    const branchStateUpdates = queries.filter((query) => query.sql.includes('update document_branch_states'));

    expect(transactions).toHaveLength(2);
    expect(branchStateUpdates).toHaveLength(1);
    expect(versionInserts.map((query) => query.params)).toEqual([
      ['doc_001', 'br_main', 'ver_001', 2, expectedAgentMarkdown, expectedAgentHash, 'agent', null, 'write'],
    ]);
    expect(result).toMatchObject({ versionId: 'ver_002', versionNumber: 2, hash: expectedAgentHash });
  });

  it('rejects a write if another API write changes the base before the locked apply transaction', async () => {
    const { pool, queries } = createFakePool({
      currentMarkdown: '# Concurrent result\n',
      currentHash: 'sha256:concurrent',
      headVersionId: 'ver_concurrent',
      headHash: 'sha256:concurrent',
      stateFingerprints: ['102'],
    });
    const liveWriter = createCapturingLiveWriter('# Stale agent result\n');

    await expect(
      applyMarkdownToBranchState({
        pool,
        liveWriter,
        docId: 'doc_001',
        branchId: 'br_main',
        parentVersionId: 'ver_001',
        markdown: '# Stale agent result\n',
        operation: { kind: 'write', baseVersionId: 'ver_001', baseHash: 'sha256:head' },
        actorType: 'agent',
      }),
    ).rejects.toThrow('stale_base_version');

    expect(queries.some((query) => query.sql.includes('update document_branch_states'))).toBe(false);
    expect(queries.some((query) => query.sql.includes('insert into document_versions'))).toBe(false);
  });

  it('rebases an exact edit onto the locked live markdown before applying it', async () => {
    const { pool, queries } = createFakePool({
      currentMarkdown: 'A old\nB concurrent\n',
      currentHash: 'sha256:concurrent',
      stateFingerprints: ['102'],
    });
    const transactions: LiveMarkdownTransaction[] = [];
    const liveWriter: LiveMarkdownWriter = {
      async applyMarkdownTransaction(transaction) {
        transactions.push(transaction);
        return {
          serializedMarkdown: transaction.targetCanonicalMarkdown,
          yjsState: createValidYjsState(),
          sourceStateFingerprint: '102',
          previousSerializedMarkdown: 'A old\nB concurrent\n',
          previousHash: 'sha256:concurrent',
          changedRangeCount: 1,
          changedCharacterCount: transaction.targetCanonicalMarkdown.length,
          documentCharacterCount: transaction.targetCanonicalMarkdown.length,
          fullDocumentReplacement: false,
          appliedTransactionCount: 1,
        };
      },
    };

    const result = await applyMarkdownToBranchState({
      pool,
      liveWriter,
      docId: 'doc_001',
      branchId: 'br_main',
      parentVersionId: 'ver_001',
      markdown: 'A new\n',
      operation: { kind: 'edit', oldString: 'A old', newString: 'A new', replaceAll: false },
      actorType: 'agent',
    });

    const expectedMarkdown = await canonicalizeMarkdown('A new\nB concurrent\n');
    const expectedHash = sha256Hex(expectedMarkdown);

    expect(transactions.map((transaction) => transaction.targetCanonicalMarkdown)).toEqual(['A new\n', expectedMarkdown]);
    expect(queries.some((query) => query.sql.includes('update document_branch_states'))).toBe(true);
    expect(result).toMatchObject({ versionId: 'ver_002', versionNumber: 2, hash: expectedHash });
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
