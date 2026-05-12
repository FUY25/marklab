import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type { DbPool, DbQueryResult, DbTransactionClient } from '../db/client';
import { toRoomName } from '../collab/persistence';
import { createHttpApp, type HttpRequestAuth } from '../http/app';
import {
  createUnavailableLiveMarkdownWriter,
  type LiveMarkdownTransaction,
  type LiveMarkdownWriter,
} from '../services/live-writer';
import { flushBranchMarkdownMirror, initializeBranchEditorState } from '../services/milkdown-transformer';

vi.mock('../services/milkdown-transformer', () => ({
  initializeBranchEditorState: vi.fn(async () => ({
    yjsState: Uint8Array.from([0, 0]),
    markdown: '# Branch copy\n',
    hash: 'sha256:branch-copy',
  })),
  flushBranchMarkdownMirror: vi.fn(async () => undefined),
}));

const originalRequireAuth = process.env.MARKLAB_REQUIRE_AUTH;
const originalDevAnonymousCollab = process.env.MARKLAB_ENABLE_DEV_ANONYMOUS_COLLAB;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

beforeEach(() => {
  process.env.MARKLAB_REQUIRE_AUTH = 'false';
  process.env.MARKLAB_ENABLE_DEV_ANONYMOUS_COLLAB = 'true';
  vi.mocked(initializeBranchEditorState).mockReset();
  vi.mocked(initializeBranchEditorState).mockResolvedValue({
    yjsState: Uint8Array.from([0, 0]),
    markdown: '# Branch copy\n',
    hash: 'sha256:branch-copy',
  });
  vi.mocked(flushBranchMarkdownMirror).mockReset();
  vi.mocked(flushBranchMarkdownMirror).mockImplementation(async () => undefined as never);
});

afterEach(() => {
  restoreEnv('MARKLAB_REQUIRE_AUTH', originalRequireAuth);
  restoreEnv('MARKLAB_ENABLE_DEV_ANONYMOUS_COLLAB', originalDevAnonymousCollab);
});

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

    if (sql.includes('b.name as branch_name')) {
      return {
        rows: [
          {
            doc_id: 'doc_001',
            branch_id: params?.[1] ?? 'br_main',
            title: 'Launch notes',
            branch_name: params?.[1] === 'br_draft' ? 'Draft' : 'Main',
            branch_slug: params?.[1] === 'br_draft' ? 'draft' : 'main',
          } as Row,
        ],
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
          {
            id: 'br_draft',
            name: 'Draft',
            slug: 'draft',
            head_version_id: 'ver_003',
            created_from_version_id: 'ver_001',
            is_archived: false,
            version_number: 3,
          } as Row,
        ],
        rowCount: 2,
      };
    }

    if (sql.includes('select markdown_snapshot, hash')) {
      return {
        rows: [{ markdown_snapshot: '# Source\n', hash: 'sha256:source' } as Row],
        rowCount: 1,
      };
    }

    if (sql.includes('select id, branch_id') && sql.includes('from document_versions')) {
      return {
        rows: [
          {
            id: 'ver_001',
            branch_id: 'br_main',
            parent_version_id: null,
            version_number: 1,
            markdown_snapshot: '# Source\n',
            hash: 'sha256:source',
            actor_type: 'system',
            actor_id: null,
            operation: 'import',
            created_at: new Date('2026-04-29T12:00:00Z'),
          } as Row,
        ],
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
  sourceBranchId?: string;
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
            branch_id: params?.[1] ?? 'br_main',
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
            branch_id: options.sourceBranchId ?? 'br_main',
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

function createBranchScopedAuth(role: 'view' | 'edit' = 'view'): HttpRequestAuth {
  return {
    async requireAdminAccess() {
      throw new Error('forbidden');
    },
    async requireDocumentAccess(_req, docId, branchId, operation) {
      if (docId !== 'doc_001' || branchId !== 'br_main') throw new Error('forbidden');
      if (operation === 'write' && role !== 'edit') throw new Error('forbidden');
      return { actorType: 'user', grantId: 'agr_1', grantSource: 'document_access_grants', role };
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
        {
          branchId: 'br_draft',
          name: 'Draft',
          slug: 'draft',
          headVersionId: 'ver_003',
          createdFromVersionId: 'ver_001',
          isArchived: false,
          headVersionNumber: 3,
        },
      ],
    });
  });

  it('does not leak non-shared branches through document metadata to branch-scoped access grants', async () => {
    const { pool } = createFakePool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter(), { auth: createBranchScopedAuth('view') });

    const response = await request(app).get('/api/docs/doc_001').expect(200);

    expect(response.body.branches).toEqual([
      {
        branchId: 'br_main',
        name: 'Main',
        slug: 'main',
        headVersionId: 'ver_002',
        createdFromVersionId: null,
        isArchived: false,
        headVersionNumber: 2,
      },
    ]);
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
        {
          branchId: 'br_draft',
          name: 'Draft',
          slug: 'draft',
          headVersionId: 'ver_003',
          createdFromVersionId: 'ver_001',
          isArchived: false,
          headVersionNumber: 3,
        },
      ],
    });
  });

  it('does not return the full branch list to branch-scoped access grants', async () => {
    const { pool } = createFakePool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter(), { auth: createBranchScopedAuth('view') });

    await request(app).get('/api/docs/doc_001/branches').expect(403, { error: 'forbidden' });
  });

  it('returns branch-scoped summary for a shared non-default branch', async () => {
    const { pool } = createFakePool();
    const auth: HttpRequestAuth = {
      async requireAdminAccess() {
        throw new Error('forbidden');
      },
      async requireDocumentAccess(_req, docId, branchId, operation) {
        if (docId !== 'doc_001' || branchId !== 'br_draft') throw new Error('forbidden');
        if (operation === 'write') throw new Error('forbidden');
        return { actorType: 'user', grantId: 'agr_draft', role: 'view' };
      },
    };
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter(), { auth });

    await request(app).get('/api/docs/doc_001/branches/br_draft/summary').expect(200, {
      docId: 'doc_001',
      branchId: 'br_draft',
      title: 'Launch notes',
      branchName: 'Draft',
      branchSlug: 'draft',
      access: {
        canRead: true,
        canWrite: false,
        canManageAccess: false,
        canManageVersions: false,
        canSwitchBranches: false,
        actorType: 'user',
        grantId: 'agr_draft',
        role: 'view',
      },
    });
  });

  it('does not advertise access management to workspace members with edit access', async () => {
    const { pool } = createFakePool();
    const auth: HttpRequestAuth = {
      async requireAdminAccess() {
        throw new Error('forbidden');
      },
      async requireDocumentAccess(_req, docId, branchId, operation) {
        if (docId !== 'doc_001' || branchId !== 'br_main') throw new Error('forbidden');
        return {
          actorType: 'user',
          actorId: 'user_member',
          canManageAccess: false,
          role: operation === 'write' ? 'edit' : 'edit',
        };
      },
    };
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter(), { auth });

    await request(app).get('/api/docs/doc_001/branches/br_main/summary').expect(200, {
      docId: 'doc_001',
      branchId: 'br_main',
      title: 'Launch notes',
      branchName: 'Main',
      branchSlug: 'main',
      access: {
        canRead: true,
        canWrite: true,
        canManageAccess: false,
        canManageVersions: true,
        canSwitchBranches: false,
        actorType: 'user',
        role: 'edit',
      },
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

  it('does not expose version history to public view grants', async () => {
    const { pool } = createFakePool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter(), { auth: createBranchScopedAuth('view') });

    await request(app)
      .get('/api/docs/doc_001/branches/br_main/versions')
      .expect(403, { error: 'forbidden' });
  });

  it('does not expose version snapshots to public view grants', async () => {
    const { pool } = createFakePool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter(), { auth: createBranchScopedAuth('view') });

    await request(app)
      .get('/api/docs/doc_001/versions/ver_001')
      .expect(403, { error: 'forbidden' });
  });

  it('allows edit grants to inspect branch version history', async () => {
    const { pool } = createFakePool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter(), { auth: createBranchScopedAuth('edit') });

    await request(app)
      .get('/api/docs/doc_001/branches/br_main/versions')
      .expect(200);
    await request(app)
      .get('/api/docs/doc_001/versions/ver_001')
      .expect(200);
  });

  it('manual save flushes active collab state before creating a manual_save checkpoint', async () => {
    const events: string[] = [];
    vi.mocked(flushBranchMarkdownMirror).mockImplementationOnce(async () => {
      events.push('checkpoint');
      return {
        branchId: 'br_main',
        markdown: '# Saved\n',
        hash: 'sha256:saved',
        versionId: 'ver_manual',
        versionNumber: 3,
        createdVersion: true,
      };
    });
    const { pool } = createFakePool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter(), {
      auth: {
        async requireAdminAccess() {
          throw new Error('forbidden');
        },
        async requireDocumentAccess(_req, docId, branchId, operation) {
          expect({ docId, branchId, operation }).toEqual({
            docId: 'doc_001',
            branchId: 'br_main',
            operation: 'write',
          });
          return { actorType: 'user', actorId: 'user_member', role: 'edit' };
        },
      },
      async flushCollabDocument(roomName) {
        expect(roomName).toBe(toRoomName('doc_001', 'br_main'));
        events.push('flush');
      },
    });

    await request(app)
      .post('/api/docs/doc_001/branches/br_main/versions/manual-save')
      .expect(200, {
        created: true,
        versionId: 'ver_manual',
        versionNumber: 3,
        hash: 'sha256:saved',
      });

    expect(events).toEqual(['flush', 'checkpoint']);
    expect(flushBranchMarkdownMirror).toHaveBeenCalledWith(pool, 'doc_001', 'br_main', 'manual_save', {
      actorType: 'user',
      actorId: 'user_member',
    });
  });

  it('manual save returns the current head when the freshly flushed branch is unchanged', async () => {
    vi.mocked(flushBranchMarkdownMirror).mockResolvedValueOnce({
      branchId: 'br_main',
      markdown: '# Saved\n',
      hash: 'sha256:saved',
      versionId: 'ver_head',
      versionNumber: 2,
      createdVersion: false,
    });
    const { pool } = createFakePool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter());

    await request(app)
      .post('/api/docs/doc_001/branches/br_main/versions/manual-save')
      .expect(200, {
        created: false,
        versionId: 'ver_head',
        versionNumber: 2,
        hash: 'sha256:saved',
      });
  });

  it('autosave flushes active collab state before creating a quiet autosave checkpoint', async () => {
    const events: string[] = [];
    vi.mocked(flushBranchMarkdownMirror).mockImplementationOnce(async () => {
      events.push('checkpoint');
      return {
        branchId: 'br_main',
        markdown: '# Autosaved\n',
        hash: 'sha256:autosaved',
        versionId: 'ver_autosave',
        versionNumber: 4,
        createdVersion: true,
      };
    });
    const { pool } = createFakePool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter(), {
      auth: {
        async requireAdminAccess() {
          throw new Error('forbidden');
        },
        async requireDocumentAccess(_req, docId, branchId, operation) {
          expect({ docId, branchId, operation }).toEqual({
            docId: 'doc_001',
            branchId: 'br_main',
            operation: 'write',
          });
          return { actorType: 'agent', actorId: 'agent_001', role: 'edit' };
        },
      },
      async flushCollabDocument(roomName) {
        expect(roomName).toBe(toRoomName('doc_001', 'br_main'));
        events.push('flush');
      },
    });

    await request(app)
      .post('/api/docs/doc_001/branches/br_main/versions/autosave')
      .expect(200, {
        created: true,
        versionId: 'ver_autosave',
        versionNumber: 4,
        hash: 'sha256:autosaved',
      });

    expect(events).toEqual(['flush', 'checkpoint']);
    expect(flushBranchMarkdownMirror).toHaveBeenCalledWith(pool, 'doc_001', 'br_main', 'autosave', {
      actorType: 'agent',
      actorId: 'agent_001',
    });
  });

  it('hides branch-from-version through the mounted HTTP app', async () => {
    vi.mocked(initializeBranchEditorState).mockClear();
    const { pool } = createFakePool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter());

    await request(app)
      .post('/api/docs/doc_001/versions/ver_001/branch')
      .send({ name: 'Draft Copy' })
      .expect(404, { error: 'not_found' });

    expect(initializeBranchEditorState).not.toHaveBeenCalled();
  });

  it('hides branch-from-version before branch-scoped access checks', async () => {
    const { pool } = createFakePool();
    const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter(), { auth: createBranchScopedAuth('edit') });

    await request(app)
      .post('/api/docs/doc_001/versions/ver_001/branch')
      .send({ name: 'Draft Copy' })
      .expect(404, { error: 'not_found' });
  });

  it('restores a source version as a rollback version through the live writer path', async () => {
    const events: string[] = [];
    const { pool, queries } = createRestorePool({ events });
    const liveWriter = createRestoreLiveWriter();
    const flushedRooms: string[] = [];
    const appliedRooms: Array<{ roomName: string; yjsState: Uint8Array }> = [];
    const app = createHttpApp(pool, liveWriter, {
      auth: {
        async requireAdminAccess() {
          throw new Error('forbidden');
        },
        async requireDocumentAccess(_req, docId, branchId, operation) {
          expect({ docId, branchId, operation }).toEqual({
            docId: 'doc_001',
            branchId: 'br_main',
            operation: 'write',
          });
          return { actorType: 'user', actorId: 'user_member', role: 'edit' };
        },
      },
      async flushCollabDocument(roomName) {
        flushedRooms.push(roomName);
        events.push('flush');
      },
      async applyCollabDocumentState(roomName, yjsState) {
        appliedRooms.push({ roomName, yjsState });
      },
    });

    const response = await request(app)
      .post('/api/docs/doc_001/branches/br_main/restore')
      .send({ versionId: 'ver_source' })
      .expect(200);

    expect(flushedRooms).toEqual([toRoomName('doc_001', 'br_main')]);
    expect(appliedRooms).toEqual([{ roomName: toRoomName('doc_001', 'br_main'), yjsState: liveWriter.yjsState }]);
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
    expect(liveWriter.yjsState.byteLength).toBeGreaterThan(0);

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
      'user',
      'user_member',
      'rollback',
    ]);
    expect(queries.some((query) => query.sql.includes('delete from document_versions'))).toBe(false);
    expect(queries.some((query) => query.sql.includes('update document_versions'))).toBe(false);

    const branchHeadUpdates = queries.filter((query) => query.sql.includes('update document_branches'));
    expect(branchHeadUpdates.at(-1)?.params).toEqual(['br_main', 'ver_rollback']);
  });

  it('restores only the requested branch state and active collaboration room', async () => {
    const { pool, queries } = createRestorePool({ sourceBranchId: 'br_feature' });
    const liveWriter = createRestoreLiveWriter();
    const flushedRooms: string[] = [];
    const appliedRooms: Array<{ roomName: string; yjsState: Uint8Array }> = [];
    const app = createHttpApp(pool, liveWriter, {
      async flushCollabDocument(roomName) {
        flushedRooms.push(roomName);
      },
      async applyCollabDocumentState(roomName, yjsState) {
        appliedRooms.push({ roomName, yjsState });
      },
    });

    await request(app)
      .post('/api/docs/doc_001/branches/br_feature/restore')
      .send({ versionId: 'ver_source' })
      .expect(200);

    expect(flushedRooms).toEqual([toRoomName('doc_001', 'br_feature')]);
    expect(appliedRooms).toEqual([{ roomName: toRoomName('doc_001', 'br_feature'), yjsState: liveWriter.yjsState }]);
    expect(liveWriter.transactions[0]?.branchId).toBe('br_feature');

    const stateUpdates = queries.filter((query) => query.sql.includes('update document_branch_states'));
    expect(stateUpdates).toHaveLength(1);
    expect(stateUpdates[0]?.params?.[0]).toBe('br_feature');
    expect(stateUpdates.some((query) => query.params?.[0] === 'br_main')).toBe(false);

    const rollbackInsert = queries.find(
      (query) => query.sql.includes('insert into document_versions') && query.params?.[8] === 'rollback',
    );
    expect(rollbackInsert?.params?.[1]).toBe('br_feature');

    const branchHeadUpdates = queries.filter((query) => query.sql.includes('update document_branches'));
    expect(branchHeadUpdates.at(-1)?.params).toEqual(['br_feature', 'ver_rollback']);
  });

  it('checkpoints dirty live state before restoring a source version', async () => {
    const { pool, queries } = createRestorePool({
      currentMarkdown: '# Dirty live draft\n',
      currentHash: 'sha256:dirty',
      headVersionId: 'ver_head',
      headHash: 'sha256:head',
    });
    const liveWriter = createRestoreLiveWriter('# Dirty live draft\n', 'sha256:dirty');
    const app = createHttpApp(pool, liveWriter, {
      auth: {
        async requireAdminAccess() {
          throw new Error('forbidden');
        },
        async requireDocumentAccess(_req, docId, branchId, operation) {
          expect({ docId, branchId, operation }).toEqual({
            docId: 'doc_001',
            branchId: 'br_main',
            operation: 'write',
          });
          return { actorType: 'user', actorId: 'user_member', role: 'edit' };
        },
      },
    });

    await request(app)
      .post('/api/docs/doc_001/branches/br_main/restore')
      .send({ versionId: 'ver_source' })
      .expect(200);

    const versionInserts = queries.filter((query) => query.sql.includes('insert into document_versions'));
    expect(versionInserts.map((query) => query.params?.[8])).toEqual(['manual_save', 'rollback']);
    expect(versionInserts.map((query) => query.params?.[2])).toEqual(['ver_head', 'ver_checkpoint']);
    expect(versionInserts.map((query) => [query.params?.[6], query.params?.[7]])).toEqual([
      ['user', 'user_member'],
      ['user', 'user_member'],
    ]);
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

  it('rejects restore requests that reference a source version from another branch in the same document', async () => {
    const { pool, queries } = createRestorePool({ sourceBranchId: 'br_other' });
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

  it('requires edit access before restore flushes or writes live state', async () => {
    const events: string[] = [];
    const { pool } = createRestorePool({ events });
    const liveWriter = createRestoreLiveWriter();
    const app = createHttpApp(pool, liveWriter, {
      auth: {
        async requireAdminAccess() {
          throw new Error('forbidden');
        },
        async requireDocumentAccess(_req, docId, branchId, operation) {
          expect({ docId, branchId, operation }).toEqual({
            docId: 'doc_001',
            branchId: 'br_main',
            operation: 'write',
          });
          throw new Error('forbidden');
        },
      },
      async flushCollabDocument() {
        events.push('flush');
      },
      async applyCollabDocumentState() {
        events.push('apply');
      },
    });

    await request(app)
      .post('/api/docs/doc_001/branches/br_main/restore')
      .send({ versionId: 'ver_source' })
      .expect(403, { error: 'forbidden' });

    expect(events).toEqual([]);
    expect(liveWriter.transactions).toEqual([]);
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
