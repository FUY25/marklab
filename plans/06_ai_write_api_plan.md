# AI Read, Write, and Edit API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose Claude Code-like tools for agents to read canonical Markdown, safely submit guarded full-document Markdown, and apply exact local string edits.

**Architecture:** REST routes operate on the canonical Markdown mirror for validation, update the live Yjs-bound ProseMirror document through a minimal transaction writer, then derive mirror/hash/version from the serialized live document.

**Tech Stack:** Express, Zod, Postgres, shared edit utilities, canonical Markdown formatter.

---

## File Structure

- Use: `apps/api/src/services/doc-read.ts` — shared canonical branch state reader created in `plans/04_import_export_plan.md`.
- Create: `apps/api/src/services/doc-write.ts` — safe write/edit service.
- Create: `apps/api/src/services/live-writer.ts` — minimal transaction live writer contract.
- Create: `apps/api/src/services/editor-state.ts` — update Milkdown/Yjs branch state from Markdown through minimal transactions.
- Create: `apps/api/src/routes/doc-ai-routes.ts` — REST routes.
- Modify: `apps/api/src/http/app.ts` — mount routes.
- Test: `apps/api/src/services/doc-write.test.ts`.
- Test: `apps/api/src/services/editor-state.test.ts`.
- Test: `apps/api/src/routes/doc-ai-routes.test.ts`.

## Scope Check

This plan does not build MCP or UI. It only builds HTTP APIs and service logic. It explicitly does not build AI streaming UX, in-app selection-aware AI, or in-app diff UI.

> **Execution gate:** The HTTP route shape may exist before the concrete writer is wired, but accepted write/edit execution must fail closed with `503 live_writer_not_configured` until a concrete minimal transaction live writer exists. The writer must parse target canonical Markdown into an editor document, compare it to the current live Yjs-bound ProseMirror document, apply only changed ranges through ProseMirror transactions/Yjs updates, and return serialized Markdown from the resulting live state. The version service from `plans/05_version_branch_plan.md` must also exist before successful write/edit execution is enabled.

> **Context note:** The original plan included a mirror-only first pass for `applyMarkdownToBranchState`. That directly conflicts with the architecture rule that AI writes must update live collaboration state before updating the canonical mirror. The corrected plan makes the live-state writer an explicit dependency instead of shipping a route that can desync online editors.
>
> **2026-04-29 Crepe update:** Do not use `Crepe.Feature.AI` as the write path in this plan. Crepe's AI streaming/diff workflow can be studied later as a UI reference, but accepted AI writes must still call the backend route, pass stale-base checks, update live Yjs/Milkdown state through `LiveMarkdownWriter`, serialize canonical Markdown back from that live state, and create an immutable version.

## Agent Review Policy

The MVP review loop belongs to Codex/Claude Code, not to an in-app diff UI or MarkLab server-side change-set workflow. The model is responsible for explaining meaningful changes in chat before invoking a write tool. The server is responsible for deterministic execution, conflict detection, live editor synchronization, and version history.

Use `edit_doc` only for one small exact replacement. Use `write_doc` for full target Markdown when a change touches multiple regions, changes structure, rewrites prose, deletes content, or cannot be represented as one exact `oldString -> newString` operation. The public MVP API does not include `preview_doc_change`, `apply_doc_change`, change-set persistence, default local proposal snapshots, or `multi_edit_doc`.

### Task 1: Document read service dependency check

**Files:**
- Use: `apps/api/src/services/doc-read.ts`

- [ ] **Step 1: Verify shared read service contract**

Confirm `apps/api/src/services/doc-read.ts` already exists from `plans/04_import_export_plan.md` and exports this contract:

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

The returned `hash` is the current canonical mirror hash and is used as `baseHash`. The returned `versionId` is the branch head version id and is used as `baseVersionId`.

- [ ] **Step 2: Run typecheck**

Run:

```bash
pnpm --filter @marklab/api typecheck
```

Expected: PASS.

- [ ] **Step 3: Continue without committing**

No commit is required in this task unless the read service contract has drifted and needs a targeted fix.

### Task 2: Minimal transaction editor state update contract

**Files:**
- Create: `apps/api/src/services/live-writer.ts`
- Create: `apps/api/src/services/editor-state.ts`

- [ ] **Step 1: Create live writer contract**

Create `apps/api/src/services/live-writer.ts`:

```ts
export type LiveMarkdownOperation =
  | {
      kind: 'write';
      baseVersionId: string;
      baseHash: string;
    }
  | {
      kind: 'edit';
      observedVersionId?: string;
      oldString: string;
      newString: string;
      replaceAll: boolean;
    };

export interface LiveMarkdownTransaction {
  branchId: string;
  targetCanonicalMarkdown: string;
  operation: LiveMarkdownOperation;
}

export interface AppliedLiveMarkdownTransaction {
  serializedMarkdown: string;
  changedRangeCount: number;
  appliedTransactionCount: number;
}

export interface LiveMarkdownWriter {
  applyMarkdownTransaction(transaction: LiveMarkdownTransaction): Promise<AppliedLiveMarkdownTransaction>;
}

export function createUnavailableLiveMarkdownWriter(): LiveMarkdownWriter {
  return {
    async applyMarkdownTransaction() {
      throw new Error('live_writer_not_configured');
    },
  };
}
```

`LiveMarkdownWriter.applyMarkdownTransaction` is a live editor writer, not a mirror writer and not a wholesale replacement writer. Its implementation must:

1. Parse `targetCanonicalMarkdown` into a Milkdown/ProseMirror document with the branch schema.
2. Read the current live Yjs-bound ProseMirror document for `branchId`.
3. Compare the target document with the current document.
4. Dispatch ProseMirror transactions/Yjs updates for only changed ranges.
5. Serialize the resulting live document back to Markdown and return it as `serializedMarkdown` with `changedRangeCount` and `appliedTransactionCount` metadata.
6. If the live Yjs document is empty but the branch mirror contains Markdown, seed the live document from `current_markdown` before diffing the target Markdown.

- [ ] **Step 2: Create editor state application service**

Create `apps/api/src/services/editor-state.ts` so `applyMarkdownToBranchState` canonicalizes the requested target, calls `liveWriter.applyMarkdownTransaction`, canonicalizes the writer's `serializedMarkdown`, hashes that live serialization, then updates `document_branch_states` and creates the immutable version in one checked-out database transaction.

The version `operation` stored in `document_versions` is `write` for `kind: 'write'` and `edit` for `kind: 'edit'`. The richer operation metadata is for the live writer and audit hooks, not for the current enum column.

> **Context note:** The original function wrote `current_markdown` directly and returned only `{ hash }`. The corrected contract first updates live branch state through `LiveMarkdownWriter`, then canonicalizes the Markdown serialized back from that live state, updates the mirror, and creates the immutable version returned to the API caller.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/live-writer.ts apps/api/src/services/editor-state.ts
git commit -m "feat: add minimal transaction editor state seam"
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
import { findEditTarget } from '@marklab/shared/src/edit-ops';

export class EditConflictError extends Error {
  constructor(message: 'old_string_not_found' | 'ambiguous_match', public readonly matchCount?: number) {
    super(message);
    this.name = 'EditConflictError';
  }
}

export function assertCanWrite(currentVersionId: string, currentHash: string, baseVersionId: string, baseHash: string): void {
  if (currentVersionId !== baseVersionId) throw new Error('stale_base_version');
  if (currentHash !== baseHash) throw new Error('stale_base_hash');
}

export function applyEditToMarkdown(markdown: string, oldString: string, newString: string, replaceAll: boolean): string {
  const target = findEditTarget(markdown, oldString, replaceAll);
  if (target.kind === 'not_found') throw new EditConflictError('old_string_not_found');
  if (target.kind === 'ambiguous') throw new EditConflictError('ambiguous_match', target.count);

  if (replaceAll) return markdown.split(oldString).join(newString);

  const index = target.indexes[0];
  if (index === undefined) throw new EditConflictError('old_string_not_found');
  return markdown.slice(0, index) + newString + markdown.slice(index + oldString.length);
}
```

> **Context note:** The original route parsed `baseVersionId` but ignored it. The corrected full-write guard validates both base version and base hash, so stale full-document writes cannot silently cross version boundaries.

`edit_doc` intentionally does not use cursor position or selection state. It applies exact `oldString`/`newString` replacement to the current canonical Markdown and then sends the resulting target Markdown through the same minimal transaction live writer as `write_doc`.

Multiple coherent changes should be submitted with `write_doc` as a full target Markdown document. The minimal transaction live writer is responsible for turning that target into changed-range editor transactions.

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
import { applyMarkdownToBranchState } from '../services/editor-state';
import type { LiveMarkdownWriter } from '../services/live-writer';

const writeSchema = z.object({
  baseVersionId: z.string().min(1),
  baseHash: z.string().min(1),
  markdown: z.string(),
});

const editSchema = z.object({
  observedVersionId: z.string().min(1).optional(),
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
        operation: { kind: 'write', baseVersionId: body.baseVersionId, baseHash: body.baseHash },
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
        operation: body.observedVersionId
          ? {
              kind: 'edit',
              observedVersionId: body.observedVersionId,
              oldString: body.oldString,
              newString: body.newString,
              replaceAll: body.replaceAll,
            }
          : {
              kind: 'edit',
              oldString: body.oldString,
              newString: body.newString,
              replaceAll: body.replaceAll,
            },
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

> **Context note:** The original routes returned only `{ hash }`, even though the API contract requires `versionId`, `versionNumber`, and `hash`. The corrected route returns version metadata after the live-state write and immutable version creation. Local edits still do not require hash equality; they target the current canonical Markdown by exact `oldString` matching.

- [ ] **Step 2: Mount routes**

Modify `apps/api/src/http/app.ts`:

```ts
import express from 'express';
import type { DbPool } from '../db/client';
import type { LiveMarkdownWriter } from '../services/live-writer';
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

The app-level error handler must map `live_writer_not_configured` to `503` so accepted write/edit requests cannot silently fall back to mirror-only persistence while the concrete minimal transaction writer is not wired.

- [ ] **Step 3: Update entrypoint call**

Modify `apps/api/src/index.ts` so the app receives `pool` and the concrete `liveWriter` created by the Milkdown/Hocuspocus writer implementation:

```ts
const app = createHttpApp(pool, liveWriter);
```

> **Context note:** The original app mounted AI routes with only a database pool, which forced route code toward mirror-only writes. Passing the live writer through app construction makes the live collaboration update dependency explicit.

- [ ] **Step 4: Run typecheck**

Run:

```bash
pnpm --filter @marklab/api typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/doc-ai-routes.ts apps/api/src/http/app.ts apps/api/src/index.ts
git commit -m "feat: add ai read write edit routes"
```
