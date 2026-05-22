import { describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '@marklab/shared/src/hash';
import type { DbExecutor, DbPool, DbQueryResult, DbTransactionClient } from '../db/client';
import {
  branchFromVersion,
  getDocumentSummary,
  listBranches,
  listVersions,
  nextVersionNumber,
  persistBranchMarkdownSnapshot,
  showVersion,
} from './version-service';
import { initializeBranchEditorState } from './milkdown-transformer';

vi.mock('./milkdown-transformer', () => ({
  initializeBranchEditorState: vi.fn(async () => ({
    yjsState: Uint8Array.from([0, 0]),
    markdown: '# Branched\n',
    hash: 'sha256:branched',
  })),
}));

interface CapturedQuery {
  sql: string;
  params?: readonly unknown[];
}

describe('nextVersionNumber', () => {
  it('starts at 1 when a branch has no versions', async () => {
    const client = {
      query: async () => ({ rows: [{ next_version_number: 1 }] }),
    };

    await expect(nextVersionNumber(client as DbExecutor, 'br_main')).resolves.toBe(1);
  });

  it('uses the next integer returned by the repository', async () => {
    const client = {
      query: async () => ({ rows: [{ next_version_number: '12' }] }),
    };

    await expect(nextVersionNumber(client as DbExecutor, 'br_main')).resolves.toBe(12);
  });
});

describe('listVersions', () => {
  it('maps version rows in descending version order', async () => {
    const pool = {
      query: async () => ({
        rows: [
          {
            id: 'ver_002',
            parent_version_id: 'ver_001',
            version_number: 2,
            hash: 'sha256:b',
            actor_type: 'agent',
            actor_id: 'agent_001',
            operation: 'write',
            created_at: new Date('2026-04-29T12:00:00Z'),
          },
        ],
      }),
    } as DbExecutor;

    await expect(listVersions(pool, 'doc_001', 'br_main')).resolves.toEqual([
      {
        versionId: 'ver_002',
        parentVersionId: 'ver_001',
        versionNumber: 2,
        hash: 'sha256:b',
        actorType: 'agent',
        actorId: 'agent_001',
        operation: 'write',
        createdAt: '2026-04-29T12:00:00.000Z',
      },
    ]);
  });
});

describe('showVersion', () => {
  it('returns the immutable markdown snapshot', async () => {
    const pool = {
      query: async () => ({
        rows: [
          {
            id: 'ver_001',
            branch_id: 'br_main',
            parent_version_id: null,
            version_number: 1,
            markdown_snapshot: '# Snapshot\n',
            hash: 'sha256:snapshot',
            actor_type: 'user',
            actor_id: null,
            operation: 'import',
            created_at: new Date('2026-04-29T12:00:00Z'),
          },
        ],
      }),
    } as DbExecutor;

    await expect(showVersion(pool, 'doc_001', 'ver_001')).resolves.toEqual({
      versionId: 'ver_001',
      branchId: 'br_main',
      parentVersionId: null,
      versionNumber: 1,
      markdown: '# Snapshot\n',
      hash: 'sha256:snapshot',
      actorType: 'user',
      actorId: null,
      operation: 'import',
      createdAt: '2026-04-29T12:00:00.000Z',
    });
  });

  it('rejects unknown versions', async () => {
    const pool = {
      query: async () => ({ rows: [] }),
    } as DbExecutor;

    await expect(showVersion(pool, 'doc_001', 'ver_missing')).rejects.toThrow('version_not_found');
  });
});

describe('getDocumentSummary', () => {
  it('maps document metadata for API consumers', async () => {
    const pool = {
      query: async () => ({
        rows: [{ id: 'doc_001', title: 'Launch notes', default_branch_id: 'br_main' }],
      }),
    } as DbExecutor;

    await expect(getDocumentSummary(pool, 'doc_001')).resolves.toEqual({
      docId: 'doc_001',
      title: 'Launch notes',
      defaultBranchId: 'br_main',
    });
  });

  it('rejects unknown documents', async () => {
    const pool = {
      query: async () => ({ rows: [] }),
    } as DbExecutor;

    await expect(getDocumentSummary(pool, 'doc_missing')).rejects.toThrow('document_not_found');
  });
});

describe('listBranches', () => {
  it('maps branch metadata with head version numbers', async () => {
    const pool = {
      query: async () => ({
        rows: [
          {
            id: 'br_main',
            name: 'Main',
            slug: 'main',
            head_version_id: 'ver_002',
            created_from_version_id: null,
            is_archived: false,
            version_number: 2,
          },
        ],
      }),
    } as DbExecutor;

    await expect(listBranches(pool, 'doc_001')).resolves.toEqual([
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
});

function createBranchPool() {
  const queries: CapturedQuery[] = [];

  const query: DbPool['query'] = async <Row = unknown>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<DbQueryResult<Row>> => {
    queries.push(params === undefined ? { sql } : { sql, params });

    if (sql.includes('select markdown_snapshot, hash')) {
      return {
        rows: [{ markdown_snapshot: '# Source\n', hash: 'sha256:source' } as Row],
        rowCount: 1,
      };
    }

    if (sql.includes('insert into document_branches')) {
      return { rows: [{ id: 'br_new' } as Row], rowCount: 1 };
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

describe('branchFromVersion', () => {
  it('initializes the new branch editor state from the selected version snapshot', async () => {
    const { pool, queries } = createBranchPool();

    await expect(branchFromVersion(pool, 'doc_001', 'ver_source', 'Draft', 'draft')).resolves.toEqual({
      branchId: 'br_new',
      versionId: 'ver_branch',
    });

    expect(initializeBranchEditorState).toHaveBeenCalledWith('# Source\n');

    const stateInsert = queries.find((query) => query.sql.includes('insert into document_branch_states'));
    expect(stateInsert?.params).toEqual([
      'br_new',
      Buffer.from(Uint8Array.from([0, 0])),
      expect.any(String),
      '# Branched\n',
      'sha256:branched',
    ]);

    const versionInsert = queries.find((query) => query.sql.includes('insert into document_versions'));
    expect(versionInsert?.params).toEqual([
      'doc_001',
      'br_new',
      'ver_source',
      '# Branched\n',
      'sha256:branched',
    ]);
  });
});

function createPersistPool(input: {
  currentHeadHash?: string;
  currentBranchHash?: string;
  lastAutosaveAt?: Date | null;
  pendingHash?: string | null;
  activeStartedAt?: Date | null;
  pendingFirstSeenAt?: Date | null;
  nextVersionNumber?: number;
  versionCreatedAt?: Date;
}) {
  const queries: CapturedQuery[] = [];
  const oldAutosaveIds = ['ver_old_auto'];

  const query: DbPool['query'] = async <Row = unknown>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<DbQueryResult<Row>> => {
    queries.push(params === undefined ? { sql } : { sql, params });

    if (sql.includes('select b.head_version_id')) {
      return {
        rows: [{
          head_version_id: 'ver_head',
          head_version_number: 5,
          head_hash: input.currentHeadHash ?? 'sha256:head',
          current_hash: input.currentBranchHash ?? 'sha256:head',
        } as Row],
        rowCount: 1,
      };
    }

    if (sql.includes('update document_branch_states')) {
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes('from document_branch_autosave_state')) {
      return {
        rows: [{
          pending_hash: input.pendingHash ?? null,
          active_started_at: input.activeStartedAt ?? null,
          pending_first_seen_at: input.pendingFirstSeenAt ?? null,
        } as Row],
        rowCount: 1,
      };
    }

    if (sql.includes('insert into document_branch_autosave_state')) {
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes('delete from document_branch_autosave_state')) {
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes('select max(created_at) as last_autosave_at')) {
      return {
        rows: [{ last_autosave_at: input.lastAutosaveAt ?? null } as Row],
        rowCount: 1,
      };
    }

    if (sql.includes('select coalesce(max(version_number), 0) + 1')) {
      return { rows: [{ next_version_number: input.nextVersionNumber ?? 6 } as Row], rowCount: 1 };
    }

    if (sql.includes('insert into document_versions')) {
      return { rows: [{ id: 'ver_new_auto' } as Row], rowCount: 1 };
    }

    if (sql.includes('update document_branches') && sql.includes('set head_version_id')) {
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes('select max(created_at) as branch_edit_clock')) {
      return {
        rows: [{ branch_edit_clock: input.versionCreatedAt ?? new Date('2026-05-01T12:00:00Z') } as Row],
        rowCount: 1,
      };
    }

    if (sql.includes('select id') && sql.includes('operation = \'autosave\'') && sql.includes('created_at <')) {
      return { rows: oldAutosaveIds.map((id) => ({ id }) as Row), rowCount: oldAutosaveIds.length };
    }

    if (sql.includes('update document_versions') && sql.includes('parent_version_id = null')) {
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes('update document_branches') && sql.includes('created_from_version_id = null')) {
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes('delete from document_versions') && sql.includes('operation = \'autosave\'')) {
      return { rows: oldAutosaveIds.map((id) => ({ id }) as Row), rowCount: oldAutosaveIds.length };
    }

    if (/^(begin|commit|rollback)$/iu.test(sql.trim())) return { rows: [], rowCount: 0 };

    throw new Error(`unexpected query: ${sql}`);
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

describe('persistBranchMarkdownSnapshot', () => {
  it('creates a final quiet autosave when the same dirty hash has been observed for two minutes', async () => {
    const markdown = '# Final quiet state\n';
    const hash = sha256Hex(markdown);
    const { pool, queries } = createPersistPool({
      lastAutosaveAt: new Date('2026-05-01T12:09:00Z'),
      pendingHash: hash,
      activeStartedAt: new Date('2026-05-01T12:00:00Z'),
      pendingFirstSeenAt: new Date('2026-05-01T12:08:00Z'),
    });

    await expect(persistBranchMarkdownSnapshot({
      pool,
      docId: 'doc_001',
      branchId: 'br_main',
      markdown,
      hash,
      actorType: 'system',
      actorId: 'provider-autosave',
      operation: 'autosave',
      now: new Date('2026-05-01T12:10:00Z'),
    })).resolves.toMatchObject({
      versionId: 'ver_new_auto',
      versionNumber: 6,
      createdVersion: true,
    });

    const versionInsert = queries.find((query) => query.sql.includes('insert into document_versions'));
    expect(versionInsert?.params).toEqual([
      'doc_001',
      'br_main',
      'ver_head',
      6,
      markdown,
      hash,
      'system',
      'provider-autosave',
      'autosave',
    ]);
  });

  it('records pending autosave observation without moving branch head inside the active editing window', async () => {
    const markdown = '# Still changing\n';
    const hash = sha256Hex(markdown);
    const { pool, queries } = createPersistPool({
      lastAutosaveAt: new Date('2026-05-01T12:09:00Z'),
      pendingHash: 'sha256:previous-observed',
      activeStartedAt: new Date('2026-05-01T12:00:00Z'),
      pendingFirstSeenAt: new Date('2026-05-01T12:08:00Z'),
    });

    await expect(persistBranchMarkdownSnapshot({
      pool,
      docId: 'doc_001',
      branchId: 'br_main',
      markdown,
      hash,
      actorType: 'system',
      actorId: 'provider-autosave',
      operation: 'autosave',
      now: new Date('2026-05-01T12:10:00Z'),
    })).resolves.toMatchObject({
      versionId: 'ver_head',
      versionNumber: 5,
      createdVersion: false,
    });

    const pendingUpsert = queries.find((query) => query.sql.includes('insert into document_branch_autosave_state'));
    expect(pendingUpsert?.params).toEqual([
      'br_main',
      hash,
      new Date('2026-05-01T12:00:00Z'),
      new Date('2026-05-01T12:10:00Z'),
      new Date('2026-05-01T12:10:00Z'),
    ]);
    expect(queries.some((query) => query.sql.includes('insert into document_versions'))).toBe(false);
    expect(queries.filter((query) => query.sql.includes('update document_branches') && query.sql.includes('set head_version_id'))).toHaveLength(0);
  });

  it('records the first dirty autosave observation without creating an immediate version', async () => {
    const markdown = '# First provider edit\n';
    const hash = sha256Hex(markdown);
    const { pool, queries } = createPersistPool({
      lastAutosaveAt: null,
      pendingHash: null,
      pendingFirstSeenAt: null,
      activeStartedAt: null,
    });

    await expect(persistBranchMarkdownSnapshot({
      pool,
      docId: 'doc_001',
      branchId: 'br_main',
      markdown,
      hash,
      actorType: 'system',
      actorId: 'provider-autosave',
      operation: 'autosave',
      now: new Date('2026-05-01T12:00:00Z'),
    })).resolves.toMatchObject({
      versionId: 'ver_head',
      versionNumber: 5,
      createdVersion: false,
    });

    const pendingUpsert = queries.find((query) => query.sql.includes('insert into document_branch_autosave_state'));
    expect(pendingUpsert?.params).toEqual([
      'br_main',
      hash,
      new Date('2026-05-01T12:00:00Z'),
      new Date('2026-05-01T12:00:00Z'),
      new Date('2026-05-01T12:00:00Z'),
    ]);
    expect(queries.some((query) => query.sql.includes('insert into document_versions'))).toBe(false);
  });

  it('prunes only autosave versions older than the latest branch edit minus thirty days', async () => {
    const markdown = '# Manual checkpoint\n';
    const hash = sha256Hex(markdown);
    const { pool, queries } = createPersistPool({
      versionCreatedAt: new Date('2026-05-31T12:00:00Z'),
    });

    await persistBranchMarkdownSnapshot({
      pool,
      docId: 'doc_001',
      branchId: 'br_main',
      markdown,
      hash,
      actorType: 'user',
      actorId: 'user_1',
      operation: 'manual_save',
      now: new Date('2026-08-01T00:00:00Z'),
    });

    const pruneSelect = queries.find((query) =>
      query.sql.includes('operation = \'autosave\'') && query.sql.includes('created_at <'),
    );
    expect(pruneSelect?.params).toEqual(['br_main', new Date('2026-05-31T12:00:00Z'), '30 days']);
    const parentNull = queries.find((query) => query.sql.includes('update document_versions') && query.sql.includes('parent_version_id = null'));
    expect(parentNull?.params).toEqual([['ver_old_auto']]);
    const deleteOldAutosaves = queries.find((query) => query.sql.includes('delete from document_versions') && query.sql.includes('operation = \'autosave\''));
    expect(deleteOldAutosaves?.params).toEqual([['ver_old_auto']]);
  });
});
