# AI Read, Write, and Edit API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose Claude Code-like tools for agents to read canonical Markdown, safely write full Markdown, and edit local strings.

**Architecture:** REST routes operate on canonical Markdown mirror, validate conflicts, update collaborative state, and create immutable versions.

**Tech Stack:** Express, Zod, Postgres, shared edit utilities, canonical Markdown formatter.

---

## File Structure

- Create: `apps/api/src/services/doc-read.ts` — read canonical branch state.
- Create: `apps/api/src/services/doc-write.ts` — safe write/edit service.
- Create: `apps/api/src/services/editor-state.ts` — update Milkdown/Yjs branch state from Markdown.
- Create: `apps/api/src/routes/doc-ai-routes.ts` — REST routes.
- Modify: `apps/api/src/http/app.ts` — mount routes.
- Test: `apps/api/src/services/doc-write.test.ts`.
- Test: `apps/api/src/routes/doc-ai-routes.test.ts`.

## Scope Check

This plan does not build MCP or UI. It only builds HTTP APIs and service logic.

> **Execution gate:** Do not execute the write/edit route task until the Milkdown spike has produced a concrete live-state writer that can replace branch Yjs/ProseMirror state from Markdown and return serialized Markdown from that live state. The version service from `plans/05_version_branch_plan.md` must also exist before this route is implemented.

> **Context note:** The original plan included a mirror-only first pass for `applyMarkdownToBranchState`. That directly conflicts with the architecture rule that AI writes must update live collaboration state before updating the canonical mirror. The corrected plan makes the live-state writer an explicit dependency instead of shipping a route that can desync online editors.
>
> **2026-04-29 Crepe update:** Do not use `Crepe.Feature.AI` as the write path in this plan. Crepe's AI streaming/diff workflow can be studied later as a UI pattern, but accepted AI writes must still call the backend route, pass stale-base checks, update live Yjs/Milkdown state through `LiveMarkdownWriter`, serialize canonical Markdown back from that live state, and create an immutable version.

### Task 1: Document read service

**Files:**
- Create: `apps/api/src/services/doc-read.ts`

- [ ] **Step 1: Implement read service**

Create `apps/api/src/services/doc-read.ts`:

```ts
import type { DbPool } from '../db/client';

export interface ReadBranchStateResult {
  docId: string;
  branchId: string;
  versionId: string;
  versionNumber: number;
  hash: string;
  markdown: string;
}

export async function readBranchState(pool: DbPool, docId: string, branchId: string): Promise<ReadBranchStateResult> {
  const result = await pool.query(
    `select
       d.id as doc_id,
       b.id as branch_id,
       v.id as version_id,
       v.version_number,
       s.current_hash,
       s.current_markdown
     from documents d
     join document_branches b on b.doc_id = d.id
     join document_branch_states s on s.branch_id = b.id
     join document_versions v on v.id = b.head_version_id
     where d.id = $1 and b.id = $2 and b.is_archived = false`,
    [docId, branchId],
  );

  const row = result.rows[0] as
    | {
        doc_id: string;
        branch_id: string;
        version_id: string;
        version_number: number;
        current_hash: string;
        current_markdown: string;
      }
    | undefined;

  if (!row) throw new Error('branch_not_found');

  return {
    docId: row.doc_id,
    branchId: row.branch_id,
    versionId: row.version_id,
    versionNumber: row.version_number,
    hash: row.current_hash,
    markdown: row.current_markdown,
  };
}
```

- [ ] **Step 2: Run typecheck**

Run:

```bash
pnpm --filter @mdcollab/api typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/doc-read.ts
git commit -m "feat: add canonical markdown read service"
```

### Task 2: Editor state update contract

**Files:**
- Create: `apps/api/src/services/editor-state.ts`

- [ ] **Step 1: Create editor state update contract**

Create `apps/api/src/services/editor-state.ts`:

```ts
import type { DbPool } from '../db/client';
import { canonicalizeMarkdown } from '@mdcollab/markdown/src/canonicalize';
import { sha256Hex } from '@mdcollab/shared/src/hash';
import { createVersion } from './version-service';

export interface LiveMarkdownWriter {
  replaceBranchMarkdown(branchId: string, canonicalMarkdown: string): Promise<string>;
}

export interface ApplyMarkdownToBranchInput {
  pool: DbPool;
  liveWriter: LiveMarkdownWriter;
  docId: string;
  branchId: string;
  parentVersionId: string;
  markdown: string;
  operation: 'write' | 'edit';
  actorType: 'agent' | 'user' | 'system';
  actorId?: string;
}

export interface ApplyMarkdownToBranchResult {
  canonicalMarkdown: string;
  hash: string;
  versionId: string;
  versionNumber: number;
}

export async function applyMarkdownToBranchState(input: ApplyMarkdownToBranchInput): Promise<ApplyMarkdownToBranchResult> {
  const requestedMarkdown = await canonicalizeMarkdown(input.markdown);
  const liveSerializedMarkdown = await input.liveWriter.replaceBranchMarkdown(input.branchId, requestedMarkdown);
  const canonicalMarkdown = await canonicalizeMarkdown(liveSerializedMarkdown);
  const hash = sha256Hex(canonicalMarkdown);

  await input.pool.query(
    `update document_branch_states
       set current_markdown = $2,
           current_hash = $3,
           updated_at = now()
     where branch_id = $1`,
    [input.branchId, canonicalMarkdown, hash],
  );

  const version = await createVersion({
    pool: input.pool,
    docId: input.docId,
    branchId: input.branchId,
    parentVersionId: input.parentVersionId,
    markdown: canonicalMarkdown,
    hash,
    actorType: input.actorType,
    actorId: input.actorId,
    operation: input.operation,
  });

  return { canonicalMarkdown, hash, ...version };
}
```

> **Context note:** The original function wrote `current_markdown` directly and returned only `{ hash }`. The corrected contract first updates live branch state through `LiveMarkdownWriter`, then canonicalizes the Markdown serialized back from that live state, updates the mirror, and creates the immutable version returned to the API caller.

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/services/editor-state.ts
git commit -m "feat: add editor state update seam"
```

### Task 3: Write/edit service tests

**Files:**
- Create: `apps/api/src/services/doc-write.test.ts`

- [ ] **Step 1: Write pure service tests with fake repo**

Create `apps/api/src/services/doc-write.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { applyEditToMarkdown, assertCanWrite } from './doc-write';

describe('assertCanWrite', () => {
  it('accepts matching base version and hash', () => {
    expect(() => assertCanWrite('ver_a', 'sha256:a', 'ver_a', 'sha256:a')).not.toThrow();
  });

  it('rejects stale base hash', () => {
    expect(() => assertCanWrite('ver_a', 'sha256:b', 'ver_a', 'sha256:a')).toThrow('stale_base_hash');
  });

  it('rejects stale base version', () => {
    expect(() => assertCanWrite('ver_b', 'sha256:a', 'ver_a', 'sha256:a')).toThrow('stale_base_version');
  });
});

describe('applyEditToMarkdown', () => {
  it('applies unique old_string replacement', () => {
    expect(applyEditToMarkdown('A\nold\nB\n', 'old', 'new', false)).toBe('A\nnew\nB\n');
  });

  it('rejects ambiguous matches', () => {
    expect(() => applyEditToMarkdown('old old', 'old', 'new', false)).toThrow('ambiguous_match');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm test apps/api/src/services/doc-write.test.ts
```

Expected: FAIL with module not found.

### Task 4: Write/edit service implementation

**Files:**
- Create: `apps/api/src/services/doc-write.ts`

- [ ] **Step 1: Implement service utilities**

Create `apps/api/src/services/doc-write.ts`:

```ts
import { applyStringEdit } from '@mdcollab/shared/src/edit-ops';

export function assertCanWrite(currentVersionId: string, currentHash: string, baseVersionId: string, baseHash: string): void {
  if (currentVersionId !== baseVersionId) throw new Error('stale_base_version');
  if (currentHash !== baseHash) throw new Error('stale_base_hash');
}

export function applyEditToMarkdown(markdown: string, oldString: string, newString: string, replaceAll: boolean): string {
  return applyStringEdit(markdown, oldString, newString, replaceAll);
}
```

> **Context note:** The original route parsed `baseVersionId` but ignored it. The corrected full-write guard validates both base version and base hash, so stale full-document writes cannot silently cross version boundaries.

- [ ] **Step 2: Run test to verify it passes**

Run:

```bash
pnpm test apps/api/src/services/doc-write.test.ts
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/doc-write.ts apps/api/src/services/doc-write.test.ts
git commit -m "feat: add ai write safety service"
```

### Task 5: AI routes

**Files:**
- Create: `apps/api/src/routes/doc-ai-routes.ts`
- Modify: `apps/api/src/http/app.ts`

- [ ] **Step 1: Implement routes**

Create `apps/api/src/routes/doc-ai-routes.ts`:

```ts
import { Router } from 'express';
import { z } from 'zod';
import type { DbPool } from '../db/client';
import { readBranchState } from '../services/doc-read';
import { applyEditToMarkdown, assertCanWrite } from '../services/doc-write';
import { applyMarkdownToBranchState, type LiveMarkdownWriter } from '../services/editor-state';

const writeSchema = z.object({
  baseVersionId: z.string().min(1),
  baseHash: z.string().min(1),
  markdown: z.string(),
});

const editSchema = z.object({
  baseVersionId: z.string().min(1),
  oldString: z.string().min(1),
  newString: z.string(),
  replaceAll: z.boolean().optional().default(false),
});

export function createDocAiRoutes(pool: DbPool, liveWriter: LiveMarkdownWriter) {
  const router = Router();

  router.get('/docs/:docId/branches/:branchId/read', async (req, res, next) => {
    try {
      res.json(await readBranchState(pool, req.params.docId, req.params.branchId));
    } catch (error) {
      next(error);
    }
  });

  router.post('/docs/:docId/branches/:branchId/write', async (req, res, next) => {
    try {
      const body = writeSchema.parse(req.body);
      const current = await readBranchState(pool, req.params.docId, req.params.branchId);
      assertCanWrite(current.versionId, current.hash, body.baseVersionId, body.baseHash);
      const applied = await applyMarkdownToBranchState({
        pool,
        liveWriter,
        docId: req.params.docId,
        branchId: req.params.branchId,
        parentVersionId: current.versionId,
        markdown: body.markdown,
        operation: 'write',
        actorType: 'agent',
      });
      res.json({ versionId: applied.versionId, versionNumber: applied.versionNumber, hash: applied.hash });
    } catch (error) {
      if (error instanceof Error && (error.message === 'stale_base_hash' || error.message === 'stale_base_version')) {
        const current = await readBranchState(pool, req.params.docId, req.params.branchId);
        res.status(409).json({
          error: error.message,
          currentVersionId: current.versionId,
          currentHash: current.hash,
        });
        return;
      }
      next(error);
    }
  });

  router.post('/docs/:docId/branches/:branchId/edit', async (req, res, next) => {
    try {
      const body = editSchema.parse(req.body);
      const current = await readBranchState(pool, req.params.docId, req.params.branchId);
      const nextMarkdown = applyEditToMarkdown(current.markdown, body.oldString, body.newString, body.replaceAll);
      const applied = await applyMarkdownToBranchState({
        pool,
        liveWriter,
        docId: req.params.docId,
        branchId: req.params.branchId,
        parentVersionId: current.versionId,
        markdown: nextMarkdown,
        operation: 'edit',
        actorType: 'agent',
      });
      res.json({ versionId: applied.versionId, versionNumber: applied.versionNumber, hash: applied.hash });
    } catch (error) {
      if (error instanceof Error && error.message === 'old_string_not_found') {
        res.status(409).json({ error: 'old_string_not_found' });
        return;
      }
      if (error instanceof Error && error.message === 'ambiguous_match') {
        res.status(409).json({ error: 'ambiguous_match' });
        return;
      }
      next(error);
    }
  });

  return router;
}
```

> **Context note:** The original routes returned only `{ hash }`, even though the API contract requires `versionId`, `versionNumber`, and `hash`. The corrected route returns version metadata after the live-state write and immutable version creation. Local edits still do not require hash equality; they target the current canonical Markdown by `oldString`.

- [ ] **Step 2: Mount routes**

Modify `apps/api/src/http/app.ts`:

```ts
import express from 'express';
import type { DbPool } from '../db/client';
import type { LiveMarkdownWriter } from '../services/editor-state';
import { createDocAiRoutes } from '../routes/doc-ai-routes';

export function createHttpApp(pool: DbPool, liveWriter: LiveMarkdownWriter) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  app.use('/api', createDocAiRoutes(pool, liveWriter));

  return app;
}
```

- [ ] **Step 3: Update entrypoint call**

Modify `apps/api/src/index.ts` so the app receives `pool` and the concrete `liveWriter` created by the Milkdown/Hocuspocus writer implementation:

```ts
const app = createHttpApp(pool, liveWriter);
```

> **Context note:** The original app mounted AI routes with only a database pool, which forced route code toward mirror-only writes. Passing the live writer through app construction makes the live collaboration update dependency explicit.

- [ ] **Step 4: Run typecheck**

Run:

```bash
pnpm --filter @mdcollab/api typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/doc-ai-routes.ts apps/api/src/http/app.ts apps/api/src/index.ts
git commit -m "feat: add ai read write edit routes"
```
