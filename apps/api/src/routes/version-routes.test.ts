import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type { DbPool, DbQueryResult, DbTransactionClient } from '../db/client';
import { toRoomName } from '../collab/persistence';
import { createHttpApp } from '../http/app';
import {
  createUnavailableLiveMarkdownWriter,
  type LiveMarkdownTransaction,
  type LiveMarkdownWriter,
} from '../services/live-writer';
import { initializeBranchEditorState } from '../services/milkdown-transformer';

vi.mock('../services/milkdown-transformer', () => ({
  initializeBranchEditorState: vi.fn(async () => ({
    yjsState: Uint8Array.from([0, 0]),
    markdown: '# Branch copy\n',
    hash: 'sha256:branch-copy',
  })),
  flushBranchMarkdownMirror: vi.fn(async () => undefined),
}));

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

    if (sql.includes('from document_versions') && sql.includes('order by version_number desc')) {
      return {
        rows: [
          {
            id: 'ver_002',
            parent_version_id: 'ver_001',
            version_number: 2,
            hash: 'sha256:b',
            actor_type: 'agent',
            actor_id: null,
            operation: 'write',
            created_at: new Date('2026-04-29T12:00:00Z'),
          } as Row,
        ],
        rowCount: 1,
      };
    }

    if (sql.includes('from documents d') && sql.includes('default_branch_id')) {
      if (params?.[0] === 'doc_missing') return { rows: [], rowCount: 0 };
      return {
        rows: [{ id: 'doc_001', title: 'Launch notes', default_branch_id: 'br_main' } as Row],
        rowCount: 1,
      };
    }

    if (sql.includes('from document_branches b') && sql.includes('left join document_versions')) {
      return {
        rows: [
          {
            id: 'br_main',
            name: 'Main',
            slug: 'main',
            head_version_id: 'ver_002',
            created_from_version_id: null,
            is_archived: false,
            version_number: 2,
          } as Row,
        ],
        rowCount: 1,
      };
    }

    if (sql.includes('select markdown_snapshot, hash')) {
      return {
        rows: [{ markdown_snapshot: '# Source\n', hash: 'sha256:source' } as Row],
        rowCount: 1,
      };
    }

    if (sql.includes('insert into document_branches')) {
      return { rows: [{ id: 'br_draft' } as Row], rowCount: 1 };
    }

    if (sql.includes('insert into document_versions')) {
      return { rows: [{ id: 'ver_branch' } as Row], rowCount: 1 };
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

interface RestorePoolOptions {
  sourceDocId?: string;
  currentMarkdown?: string;
  currentHash?: string;
  headVersionId?: string;
  headHash?: string;
  events?: string[];
}

function createValidYjsState(): Uint8Array {
  const doc = new Y.Doc();
  doc.getText('prosemirror').insert(0, 'route restore');
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

function createRestorePool(options: RestorePoolOptions = {}) {
  const queries: CapturedQuery[] = [];
  let nextVersionNumber = 3;

  const query: DbPool['query'] = async <Row = unknown>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<DbQueryResult<Row>> => {
    queries.push(params === undefined ? { sql } : { sql, params });

    if (sql.includes('from documents d') && sql.includes('current_markdown')) {
      options.events?.push('read_branch_state');
      return {
        rows: [
          {
            doc_id: 'doc_001',
            branch_id: 'br_main',
            version_id: options.headVersionId ?? 'ver_head',
            version_number: 2,
            current_hash: options.currentHash ?? 'sha256:head',
            current_markdown: options.currentMarkdown ?? '# Current\n',
          } as Row,
        ],
        rowCount: 1,
      };
    }

    if (sql.includes('from document_versions') && sql.includes('markdown_snapshot') && sql.includes('where id = $1')) {
      options.events?.push('read_source_version');
      return {
        rows: [
          {
            id: 'ver_source',
            doc_id: options.sourceDocId ?? 'doc_001',
            markdown_snapshot: '# Source snapshot\n',
          } as Row,
        ],
        rowCount: 1,
      };
    }

    if (sql.includes('from document_branches b') && sql.includes('document_branch_states')) {
      options.events?.push('read_branch_version_state');
      return {
        rows: [
          {
            current_markdown: options.currentMarkdown ?? '# Current\n',
            current_hash: options.currentHash ?? 'sha256:head',
            yjs_state: Buffer.from(createValidYjsState()),
            yjs_state_fingerprint: '101',
            head_version_id: options.headVersionId ?? 'ver_head',
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
      const operation = params?.[8];
      return {
        rows: [{ id: operation === 'manual_save' || operation === 'autosave' ? 'ver_checkpoint' : 'ver_rollback' } as Row],
        rowCount: 1,
      };
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

function createRestoreLiveWriter(
  previousMarkdown = '# Current\n',
  previousHash = 'sha256:head',
): LiveMarkdownWriter & { transactions: LiveMarkdownTransaction[]; yjsState: Uint8Array } {
  const transactions: LiveMarkdownTransaction[] = [];
  const yjsState = createValidYjsState();
  return {
    transactions,
    yjsState,
    async applyMarkdownTransaction(transaction) {
      transactions.push(transaction);
      return {
        serializedMarkdown: transaction.targetCanonicalMarkdown,
        yjsState,
        sourceStateFingerprint: '101',
        previousSerializedMarkdown: previousMarkdown,
        previousHash,
        changedRangeCount: 1,
        changedCharacterCount: transaction.targetCanonicalMarkdown.length,
        documentCharacterCount: transaction.targetCanonicalMarkdown.length,
        fullDocumentReplacement: true,
        appliedTransactionCount: 1,
      };
    },
  };
}

describe('version routes', () => {
  it('returns document metadata with branches through the mounted HTTP app', async () => {
    const { pool } = createFakePool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter());

    const response = await request(app).get('/api/docs/doc_001').expect(200);

    expect(response.body).toEqual({
      docId: 'doc_001',
      title: 'Launch notes',
      defaultBranchId: 'br_main',
      branches: [
        {
          branchId: 'br_main',
          name: 'Main',
          slug: 'main',
          headVersionId: 'ver_002',
          createdFromVersionId: null,
          isArchived: false,
          headVersionNumber: 2,
        },
      ],
    });
  });

  it('returns document branches through the mounted HTTP app', async () => {
    const { pool } = createFakePool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter());

    const response = await request(app).get('/api/docs/doc_001/branches').expect(200);

    expect(response.body).toEqual({
      branches: [
        {
          branchId: 'br_main',
          name: 'Main',
          slug: 'main',
          headVersionId: 'ver_002',
          createdFromVersionId: null,
          isArchived: false,
          headVersionNumber: 2,
        },
      ],
    });
  });

  it('returns document_not_found for unknown document metadata requests', async () => {
    const { pool } = createFakePool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter());

    await request(app).get('/api/docs/doc_missing').expect(404, { error: 'document_not_found' });
  });

  it('lists branch versions through the mounted HTTP app', async () => {
    const { pool } = createFakePool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter());

    const response = await request(app).get('/api/docs/doc_001/branches/br_main/versions').expect(200);

    expect(response.body).toEqual({
      versions: [
        {
          versionId: 'ver_002',
          parentVersionId: 'ver_001',
          versionNumber: 2,
          hash: 'sha256:b',
          actorType: 'agent',
          actorId: null,
          operation: 'write',
          createdAt: '2026-04-29T12:00:00.000Z',
        },
      ],
    });
  });

  it('branches from a version through the mounted HTTP app', async () => {
    const { pool, queries } = createFakePool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter());

    const response = await request(app)
      .post('/api/docs/doc_001/versions/ver_001/branch')
      .send({ name: 'Draft Copy' })
      .expect(201);

    expect(response.body).toEqual({ branchId: 'br_draft', headVersionId: 'ver_branch' });
    expect(initializeBranchEditorState).toHaveBeenCalledWith('# Source\n');

    const branchInsert = queries.find((query) => query.sql.includes('insert into document_branches'));
    expect(branchInsert?.params).toEqual(['doc_001', 'Draft Copy', 'draft-copy', 'ver_001']);
  });

  it('restores a source version as a rollback version through the live writer path', async () => {
    const events: string[] = [];
    const { pool, queries } = createRestorePool({ events });
    const liveWriter = createRestoreLiveWriter();
    const flushedRooms: string[] = [];
    const app = createHttpApp(pool, liveWriter, {
      async flushCollabDocument(roomName) {
        flushedRooms.push(roomName);
        events.push('flush');
      },
    });

    const response = await request(app)
      .post('/api/docs/doc_001/branches/br_main/restore')
      .send({ versionId: 'ver_source' })
      .expect(200);

    expect(flushedRooms).toEqual([toRoomName('doc_001', 'br_main')]);
    expect(events.slice(0, 3)).toEqual(['flush', 'read_branch_state', 'read_source_version']);
    expect(liveWriter.transactions).toEqual([
      {
        branchId: 'br_main',
        targetCanonicalMarkdown: '# Source snapshot\n',
        operation: { kind: 'rollback', sourceVersionId: 'ver_source' },
      },
    ]);
    expect(response.body).toEqual({
      versionId: 'ver_rollback',
      versionNumber: 3,
      hash: expect.any(String),
    });

    const stateUpdate = queries.find((query) => query.sql.includes('update document_branch_states'));
    expect(stateUpdate?.params).toEqual([
      'br_main',
      '# Source snapshot\n',
      expect.any(String),
      Buffer.from(liveWriter.yjsState),
      expect.any(String),
    ]);

    const versionInsert = queries.find((query) => query.sql.includes('insert into document_versions'));
    expect(versionInsert?.params).toEqual([
      'doc_001',
      'br_main',
      'ver_head',
      3,
      '# Source snapshot\n',
      expect.any(String),
      'system',
      null,
      'rollback',
    ]);
    expect(queries.some((query) => query.sql.includes('delete from document_versions'))).toBe(false);
    expect(queries.some((query) => query.sql.includes('update document_versions'))).toBe(false);

    const branchHeadUpdates = queries.filter((query) => query.sql.includes('update document_branches'));
    expect(branchHeadUpdates.at(-1)?.params).toEqual(['br_main', 'ver_rollback']);
  });

  it('checkpoints dirty live state before restoring a source version', async () => {
    const { pool, queries } = createRestorePool({
      currentMarkdown: '# Dirty live draft\n',
      currentHash: 'sha256:dirty',
      headVersionId: 'ver_head',
      headHash: 'sha256:head',
    });
    const liveWriter = createRestoreLiveWriter('# Dirty live draft\n', 'sha256:dirty');
    const app = createHttpApp(pool, liveWriter);

    await request(app)
      .post('/api/docs/doc_001/branches/br_main/restore')
      .send({ versionId: 'ver_source' })
      .expect(200);

    const versionInserts = queries.filter((query) => query.sql.includes('insert into document_versions'));
    expect(versionInserts.map((query) => query.params?.[8])).toEqual(['manual_save', 'rollback']);
    expect(versionInserts.map((query) => query.params?.[2])).toEqual(['ver_head', 'ver_checkpoint']);
  });

  it('rejects restore requests that reference a source version from another document', async () => {
    const { pool, queries } = createRestorePool({ sourceDocId: 'doc_other' });
    const liveWriter = createRestoreLiveWriter();
    const app = createHttpApp(pool, liveWriter);

    await request(app)
      .post('/api/docs/doc_001/branches/br_main/restore')
      .send({ versionId: 'ver_source' })
      .expect(404, { error: 'source_version_not_found' });

    expect(liveWriter.transactions).toEqual([]);
    expect(queries.some((query) => query.sql.includes('update document_branch_states'))).toBe(false);
    expect(queries.some((query) => query.sql.includes('insert into document_versions'))).toBe(false);
  });

  it('returns 503 when restore cannot reach a live writer', async () => {
    const { pool, queries } = createRestorePool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter());

    await request(app)
      .post('/api/docs/doc_001/branches/br_main/restore')
      .send({ versionId: 'ver_source' })
      .expect(503, { error: 'live_writer_not_configured' });

    expect(queries.some((query) => query.sql.includes('update document_branch_states'))).toBe(false);
    expect(queries.some((query) => query.sql.includes('insert into document_versions'))).toBe(false);
  });
});
