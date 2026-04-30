import { describe, expect, it, vi } from 'vitest';
import type { DbExecutor, DbPool, DbQueryResult, DbTransactionClient } from '../db/client';
import {
  branchFromVersion,
  getDocumentSummary,
  listBranches,
  listVersions,
  nextVersionNumber,
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
