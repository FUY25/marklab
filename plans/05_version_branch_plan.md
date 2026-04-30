# Version DAG and Branch History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store immutable canonical Markdown versions, apply the save/autosave/pre-agent checkpoint policy, and support branch-from-version without deleting discarded history.

**Architecture:** Use `document_versions` as a per-branch DAG. Each branch has a head version; branch creation copies selected snapshot into a new branch state.

**Tech Stack:** Postgres, TypeScript services, Vitest.

---

## File Structure

- Create: `apps/api/src/services/version-service.ts` — create/list versions and branch from version.
- Test: `apps/api/src/services/version-service.test.ts`.
- Create: `apps/api/src/services/save-policy.ts` — manual save, autosave throttle, and pre-agent checkpoint helpers.
- Create: `apps/api/src/routes/version-routes.ts` — list/show versions and branch-from-version HTTP endpoints.
- Use: `apps/api/src/services/milkdown-transformer.ts` — initializes Yjs state and canonical Markdown from version snapshots.
- Modify: `apps/api/src/services/editor-state.ts` — create version after write/edit.
- Modify: `apps/api/src/routes/doc-ai-routes.ts` — include version in responses.
- Modify: `apps/api/src/http/app.ts` — mount version routes.

## Scope Check

This plan only implements backend version/branch behavior. UI history display is a separate task in the web app.

## Save Policy

Version history is authoritative product state. Agent review text, tool permission, and optional local scratch files are outside the product data model and are not database records.

```text
Yjs live state + current_markdown/current_hash = working tree
document_versions = commits
```

Human typing persists through Yjs continuously and refreshes `current_markdown/current_hash` on debounce. It does not create a version per keystroke.

Create versions for:

```text
manual save:
  immediate, if current_hash differs from head version hash

autosave:
  at most once every 10 minutes per dirty branch
  trigger after roughly 30 seconds idle or on blur/page hide

pre-agent checkpoint:
  immediate, bypassing autosave throttle
  only when current_hash differs from the head version hash before an agent write/edit

agent write/edit:
  immediate after the minimal transaction live writer succeeds
```

Pre-agent checkpoint sequence:

```text
v10 = branch head version
current_markdown/current_hash = dirty human state not represented by v10
agent write/edit starts and passes its guard

create v11 = checkpoint of current human state
apply agent operation through minimal transaction live writer
create v12 = agent version, parent = v11
```

This prevents unversioned human edits from being silently bundled into an agent-authored version.

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
import { initializeBranchEditorState } from './milkdown-transformer';

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

    const initialized = await initializeBranchEditorState(sourceRow.markdown_snapshot);

    await client.query(
      `insert into document_branch_states (branch_id, yjs_state, current_markdown, current_hash)
       values ($1, $2, $3, $4)`,
      [branchId, Buffer.from(initialized.yjsState), initialized.markdown, initialized.hash],
    );

    const version = await client.query(
      `insert into document_versions
        (doc_id, branch_id, parent_version_id, version_number, markdown_snapshot, hash, actor_type, operation)
       values ($1,$2,$3,1,$4,$5,'system','branch')
       returning id`,
      [docId, branchId, sourceVersionId, initialized.markdown, initialized.hash],
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

> **Context note:** The original branch creation had the same `pg.Pool` transaction bug and also initialized `yjs_state` with an empty byte buffer. The corrected code uses one transaction client and initializes branch Yjs state through the Milkdown transformer from the selected version Markdown. If the transformer is temporarily unavailable during MVP execution, the live writer's seed-if-empty fallback must be tested before agents can write to unopened branches.

- [ ] **Step 2: Run typecheck**

Run:

```bash
pnpm --filter @marklab/api typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/version-service.ts
git commit -m "feat: add branch from version service"
```

### Task 4: Save policy helpers

**Files:**
- Create: `apps/api/src/services/save-policy.ts`
- Test: `apps/api/src/services/save-policy.test.ts`
- Modify: `apps/api/src/services/editor-state.ts`

- [ ] **Step 1: Write save policy tests**

Create `apps/api/src/services/save-policy.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { shouldCreateAutosaveVersion, shouldCreateVersionForCurrentHash } from './save-policy';

describe('shouldCreateVersionForCurrentHash', () => {
  it('creates a version when current hash differs from head hash', () => {
    expect(shouldCreateVersionForCurrentHash('sha256:working', 'sha256:head')).toBe(true);
  });

  it('skips version creation when current hash matches head hash', () => {
    expect(shouldCreateVersionForCurrentHash('sha256:same', 'sha256:same')).toBe(false);
  });
});

describe('shouldCreateAutosaveVersion', () => {
  it('allows autosave when dirty and past the throttle window', () => {
    expect(
      shouldCreateAutosaveVersion({
        currentHash: 'sha256:working',
        headHash: 'sha256:head',
        lastAutosaveAt: new Date('2026-04-29T12:00:00Z'),
        now: new Date('2026-04-29T12:10:01Z'),
      }),
    ).toBe(true);
  });

  it('blocks autosave when the branch is clean', () => {
    expect(
      shouldCreateAutosaveVersion({
        currentHash: 'sha256:same',
        headHash: 'sha256:same',
        lastAutosaveAt: null,
        now: new Date('2026-04-29T12:10:01Z'),
      }),
    ).toBe(false);
  });

  it('blocks autosave inside the throttle window', () => {
    expect(
      shouldCreateAutosaveVersion({
        currentHash: 'sha256:working',
        headHash: 'sha256:head',
        lastAutosaveAt: new Date('2026-04-29T12:05:00Z'),
        now: new Date('2026-04-29T12:10:00Z'),
      }),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Implement save policy helpers**

Create `apps/api/src/services/save-policy.ts`:

```ts
export const AUTOSAVE_VERSION_INTERVAL_MS = 10 * 60 * 1000;

export function shouldCreateVersionForCurrentHash(currentHash: string, headHash: string): boolean {
  return currentHash !== headHash;
}

export interface ShouldCreateAutosaveInput {
  currentHash: string;
  headHash: string;
  lastAutosaveAt: Date | null;
  now: Date;
}

export function shouldCreateAutosaveVersion(input: ShouldCreateAutosaveInput): boolean {
  if (!shouldCreateVersionForCurrentHash(input.currentHash, input.headHash)) return false;
  if (!input.lastAutosaveAt) return true;
  return input.now.getTime() - input.lastAutosaveAt.getTime() >= AUTOSAVE_VERSION_INTERVAL_MS;
}
```

- [ ] **Step 3: Wire pre-agent checkpoint into editor-state**

Modify `apps/api/src/services/editor-state.ts` so `applyMarkdownToBranchState` checks the current branch head version hash before creating the agent version:

```text
if current branch state's current_hash differs from the head version hash:
  create a checkpoint version with actorType = 'system' and operation = 'autosave'
  use that checkpoint as the parentVersionId for the agent version
else:
  use the current head version as the parentVersionId
```

The checkpoint is created only after the incoming write/edit has passed its own guard. For `write_doc`, this means the request's `baseVersionId` and `baseHash` still match the branch state observed before the checkpoint. The checkpoint must not turn a valid guarded write into a false stale rejection.

- [ ] **Step 4: Run tests**

Run:

```bash
pnpm test apps/api/src/services/save-policy.test.ts
pnpm --filter @marklab/api typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/save-policy.ts apps/api/src/services/save-policy.test.ts apps/api/src/services/editor-state.ts
git commit -m "feat: add version save policy helpers"
```

### Task 5: Version HTTP routes

**Files:**
- Modify: `apps/api/src/services/version-service.ts`
- Create: `apps/api/src/routes/version-routes.ts`
- Modify: `apps/api/src/http/app.ts`
- Test: `apps/api/src/routes/version-routes.test.ts`

- [ ] **Step 1: Add list/show helpers**

Extend `apps/api/src/services/version-service.ts` with:

```ts
export async function listVersions(pool: DbPool, docId: string, branchId: string) {
  const result = await pool.query(
    `select id, parent_version_id, version_number, hash, actor_type, actor_id, operation, created_at
       from document_versions
      where doc_id = $1 and branch_id = $2
      order by version_number desc`,
    [docId, branchId],
  );

  return result.rows.map((row) => ({
    versionId: row.id as string,
    parentVersionId: row.parent_version_id as string | null,
    versionNumber: row.version_number as number,
    hash: row.hash as string,
    actorType: row.actor_type as string,
    actorId: row.actor_id as string | null,
    operation: row.operation as string,
    createdAt: (row.created_at as Date).toISOString(),
  }));
}

export async function showVersion(pool: DbPool, docId: string, versionId: string) {
  const result = await pool.query(
    `select id, branch_id, parent_version_id, version_number, markdown_snapshot, hash, actor_type, actor_id, operation, created_at
       from document_versions
      where doc_id = $1 and id = $2`,
    [docId, versionId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('version_not_found');

  return {
    versionId: row.id as string,
    branchId: row.branch_id as string,
    parentVersionId: row.parent_version_id as string | null,
    versionNumber: row.version_number as number,
    markdown: row.markdown_snapshot as string,
    hash: row.hash as string,
    actorType: row.actor_type as string,
    actorId: row.actor_id as string | null,
    operation: row.operation as string,
    createdAt: (row.created_at as Date).toISOString(),
  };
}
```

- [ ] **Step 2: Create routes**

Create `apps/api/src/routes/version-routes.ts`:

```ts
import { Router } from 'express';
import { z } from 'zod';
import type { DbPool } from '../db/client';
import { branchFromVersion, listVersions, showVersion } from '../services/version-service';

const branchSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1).optional(),
});

function slugifyBranchName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'branch';
}

export function createVersionRoutes(pool: DbPool) {
  const router = Router();

  router.get('/docs/:docId/branches/:branchId/versions', async (req, res, next) => {
    try {
      res.json({ versions: await listVersions(pool, req.params.docId, req.params.branchId) });
    } catch (error) {
      next(error);
    }
  });

  router.get('/docs/:docId/versions/:versionId', async (req, res, next) => {
    try {
      res.json(await showVersion(pool, req.params.docId, req.params.versionId));
    } catch (error) {
      next(error);
    }
  });

  router.post('/docs/:docId/versions/:versionId/branch', async (req, res, next) => {
    try {
      const body = branchSchema.parse(req.body);
      const result = await branchFromVersion(
        pool,
        req.params.docId,
        req.params.versionId,
        body.name,
        body.slug ?? slugifyBranchName(body.name),
      );
      res.status(201).json({ branchId: result.branchId, headVersionId: result.versionId });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
```

- [ ] **Step 3: Mount routes**

Modify `apps/api/src/http/app.ts`:

```ts
import { createVersionRoutes } from '../routes/version-routes';

app.use('/api', createVersionRoutes(pool));
```

Mount these routes after JSON middleware and before error middleware. They must use the same `DbPool` as the import/export and AI routes.

- [ ] **Step 4: Run tests**

Run:

```bash
pnpm test apps/api/src/routes/version-routes.test.ts
pnpm --filter @marklab/api typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/version-service.ts apps/api/src/routes/version-routes.ts apps/api/src/routes/version-routes.test.ts apps/api/src/http/app.ts
git commit -m "feat: add version history routes"
```
