import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { DbPool, DbQueryResult, DbTransactionClient } from '../db/client';
import { createHeadlessMilkdownRuntime } from './milkdown-headless-runtime';
import { flushBranchMarkdownMirror, initializeBranchEditorState } from './milkdown-transformer';

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

describe('runtime-backed milkdown transformer', () => {
  it('initializes imported markdown as live Yjs state and canonical markdown', async () => {
    const result = await initializeBranchEditorState('# Imported\n\n- [ ] Task\n\n```mermaid\ngraph TD\n  A-->B\n```\n');

    expect(result.markdown).toContain('# Imported');
    expect(result.markdown).toContain('```mermaid');
    expect(result.hash).toMatch(/^sha256:/u);
    expect(result.yjsState.byteLength).toBeGreaterThan(0);

    const doc = new Y.Doc();
    Y.applyUpdate(doc, result.yjsState);
    expect(doc.getXmlFragment('prosemirror').length).toBeGreaterThan(0);
    doc.destroy();
  });

  it('creates a matching system version when dirty live state differs from branch head', async () => {
    const runtime = createHeadlessMilkdownRuntime();
    const seeded = await runtime.initializeFromMarkdown('# Dirty live\n');
    const { pool, queries } = createFlushPool({
      yjsState: seeded.yjsState,
      headHash: 'sha256:old',
    });

    const result = await flushBranchMarkdownMirror(pool, 'doc_001', 'br_main', 'manual_save');

    expect(result).toMatchObject({
      branchId: 'br_main',
      hash: seeded.hash,
      versionId: 'ver_002',
      versionNumber: 2,
      createdVersion: true,
    });
    expect(result.markdown).toBe(seeded.markdown);

    const mirrorUpdate = queries.find((query) => query.sql.includes('update document_branch_states'));
    expect(mirrorUpdate?.params).toEqual([
      'br_main',
      'doc_001',
      Buffer.from(seeded.yjsState),
      'state-fingerprint',
      seeded.markdown,
      seeded.hash,
    ]);

    const versionInsert = queries.find((query) => query.sql.includes('insert into document_versions'));
    expect(versionInsert?.params).toEqual([
      'doc_001',
      'br_main',
      'ver_001',
      2,
      seeded.markdown,
      seeded.hash,
      'system',
      null,
      'manual_save',
    ]);
  });

  it('records supplied validated actor identity when creating a dirty live-state version', async () => {
    const runtime = createHeadlessMilkdownRuntime();
    const seeded = await runtime.initializeFromMarkdown('# Member live\n');
    const { pool, queries } = createFlushPool({
      yjsState: seeded.yjsState,
      headHash: 'sha256:old',
    });

    await flushBranchMarkdownMirror(pool, 'doc_001', 'br_main', 'manual_save', {
      actorType: 'user',
      actorId: 'user_member',
    });

    const versionInsert = queries.find((query) => query.sql.includes('insert into document_versions'));
    expect(versionInsert?.params).toEqual([
      'doc_001',
      'br_main',
      'ver_001',
      2,
      seeded.markdown,
      seeded.hash,
      'user',
      'user_member',
      'manual_save',
    ]);
  });
});
