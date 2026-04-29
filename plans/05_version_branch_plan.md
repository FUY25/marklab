# Version DAG and Branch History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store immutable canonical Markdown versions and support branch-from-version without deleting discarded history.

**Architecture:** Use `document_versions` as a per-branch DAG. Each branch has a head version; branch creation copies selected snapshot into a new branch state.

**Tech Stack:** Postgres, TypeScript services, Vitest.

---

## File Structure

- Create: `apps/api/src/services/version-service.ts` — create/list versions and branch from version.
- Test: `apps/api/src/services/version-service.test.ts`.
- Modify: `apps/api/src/services/editor-state.ts` — create version after write/edit.
- Modify: `apps/api/src/routes/doc-ai-routes.ts` — include version in responses.

## Scope Check

This plan only implements backend version/branch behavior. UI history display is a separate task in the web app.

### Task 1: Version service pure behavior tests

**Files:**
- Create: `apps/api/src/services/version-service.test.ts`

- [ ] **Step 1: Write version number tests**

Create `apps/api/src/services/version-service.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { nextVersionNumber } from './version-service';

describe('nextVersionNumber', () => {
  it('starts at one when branch has no versions', () => {
    expect(nextVersionNumber(null)).toBe(1);
  });

  it('increments current number', () => {
    expect(nextVersionNumber(43)).toBe(44);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm test apps/api/src/services/version-service.test.ts
```

Expected: FAIL with module not found.

### Task 2: Version service implementation

**Files:**
- Create: `apps/api/src/services/version-service.ts`

- [ ] **Step 1: Implement version service**

Create `apps/api/src/services/version-service.ts`:

```ts
import type { DbPool } from '../db/client';
import { createEmptyYjsState } from '../collab/persistence';

export function nextVersionNumber(current: number | null): number {
  return current === null ? 1 : current + 1;
}

export interface CreateVersionInput {
  pool: DbPool;
  docId: string;
  branchId: string;
  parentVersionId: string | null;
  markdown: string;
  hash: string;
  actorType: 'user' | 'agent' | 'system';
  actorId?: string;
  operation: 'create' | 'import' | 'autosave' | 'manual_save' | 'write' | 'edit' | 'rollback' | 'branch';
}

export async function createVersion(input: CreateVersionInput) {
  const client = await input.pool.connect();
  try {
    await client.query('begin');
    const headResult = await client.query(
      `select v.version_number
         from document_branches b
         left join document_versions v on v.id = b.head_version_id
        where b.id = $1
        for update`,
      [input.branchId],
    );
    const currentNumber = (headResult.rows[0] as { version_number?: number } | undefined)?.version_number ?? null;
    const versionNumber = nextVersionNumber(currentNumber);

    const inserted = await client.query(
      `insert into document_versions
        (doc_id, branch_id, parent_version_id, version_number, markdown_snapshot, hash, actor_type, actor_id, operation)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       returning id, version_number`,
      [
        input.docId,
        input.branchId,
        input.parentVersionId,
        versionNumber,
        input.markdown,
        input.hash,
        input.actorType,
        input.actorId ?? null,
        input.operation,
      ],
    );

    const row = inserted.rows[0] as { id: string; version_number: number };
    await client.query('update document_branches set head_version_id = $1 where id = $2', [row.id, input.branchId]);
    await client.query('commit');
    return { versionId: row.id, versionNumber: row.version_number };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
```

> **Context note:** The original implementation opened a transaction through the pool and then kept querying the pool. `pg.Pool` can serve those calls from different clients, so the transaction and `for update` lock were not guaranteed. The corrected version checks out one client for the whole transaction.

- [ ] **Step 2: Run test to verify it passes**

Run:

```bash
pnpm test apps/api/src/services/version-service.test.ts
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/version-service.ts apps/api/src/services/version-service.test.ts
git commit -m "feat: add version creation service"
```

### Task 3: Branch from version service

**Files:**
- Modify: `apps/api/src/services/version-service.ts`

- [ ] **Step 1: Add branch creation function**

Append to `apps/api/src/services/version-service.ts`:

```ts
export async function branchFromVersion(pool: DbPool, docId: string, sourceVersionId: string, branchName: string, branchSlug: string) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const source = await client.query(
      `select markdown_snapshot, hash from document_versions where id = $1 and doc_id = $2`,
      [sourceVersionId, docId],
    );
    const sourceRow = source.rows[0] as { markdown_snapshot: string; hash: string } | undefined;
    if (!sourceRow) throw new Error('source_version_not_found');

    const branch = await client.query(
      `insert into document_branches (doc_id, name, slug, created_from_version_id)
       values ($1, $2, $3, $4)
       returning id`,
      [docId, branchName, branchSlug, sourceVersionId],
    );
    const branchId = (branch.rows[0] as { id: string }).id;

    await client.query(
      `insert into document_branch_states (branch_id, yjs_state, current_markdown, current_hash)
       values ($1, $2, $3, $4)`,
      [branchId, Buffer.from(createEmptyYjsState()), sourceRow.markdown_snapshot, sourceRow.hash],
    );

    const version = await client.query(
      `insert into document_versions
        (doc_id, branch_id, parent_version_id, version_number, markdown_snapshot, hash, actor_type, operation)
       values ($1,$2,$3,1,$4,$5,'system','branch')
       returning id`,
      [docId, branchId, sourceVersionId, sourceRow.markdown_snapshot, sourceRow.hash],
    );
    const versionId = (version.rows[0] as { id: string }).id;

    await client.query('update document_branches set head_version_id = $1 where id = $2', [versionId, branchId]);
    await client.query('commit');

    return { branchId, versionId };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
```

> **Context note:** The original branch creation had the same `pg.Pool` transaction bug and also initialized `yjs_state` with an empty byte buffer. The corrected code uses one transaction client and stores a valid encoded empty Yjs update from the persistence helper.

- [ ] **Step 2: Run typecheck**

Run:

```bash
pnpm --filter @mdcollab/api typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/version-service.ts
git commit -m "feat: add branch from version service"
```
