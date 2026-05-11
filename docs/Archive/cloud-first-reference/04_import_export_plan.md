# Import and Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to create blank cloud docs, create cloud docs from local Markdown, read canonical branch Markdown, and export cloud docs as metadata-rich product export files.

**Architecture:** Import parses Markdown through the Milkdown schema, initializes Yjs/ProseMirror branch state, serializes back to canonical Markdown, and creates v1. Export flushes the Milkdown serialization path before reading the canonical mirror and builds a filename that warns the file is a product export, not a source-of-truth local sync file.

**Tech Stack:** Express, Postgres, Milkdown parser/serializer transformer, Prettier markdown formatter, shared export filename builder.

---

## File Structure

- Create: `apps/api/src/services/doc-create.ts` — blank/import create flows.
- Create: `apps/api/src/services/doc-read.ts` — shared canonical branch read service used by export, AI, and CLI routes.
- Create: `apps/api/src/services/milkdown-transformer.ts` — Milkdown parser/serializer/Yjs initialization seam.
- Create: `apps/api/src/routes/import-export-routes.ts` — import/export HTTP endpoints.
- Modify: `apps/api/src/http/app.ts` — mount import/export routes.
- Test: `apps/api/src/routes/import-export-routes.test.ts`.

## Scope Check

This plan does not implement local sync and does not implement agent proposal snapshots. It only implements upload/import and product export.

### Task 0: Milkdown transformer seam

**Files:**
- Create: `apps/api/src/services/milkdown-transformer.ts`
- Test: `apps/api/src/services/milkdown-transformer.test.ts`

- [ ] **Step 1: Define transformer contract**

Create `apps/api/src/services/milkdown-transformer.ts` with a concrete implementation or a fail-closed seam:

```ts
export interface InitializedBranchEditorState {
  yjsState: Uint8Array;
  markdown: string;
  hash: string;
}

export async function initializeBranchEditorState(markdown: string): Promise<InitializedBranchEditorState> {
  throw new Error('milkdown_transformer_not_configured');
}

export async function flushBranchMarkdownMirror(_pool: unknown, _docId: string, _branchId: string): Promise<void> {
  throw new Error('milkdown_transformer_not_configured');
}
```

The real `initializeBranchEditorState` implementation must parse Markdown through Milkdown with the active editor schema, initialize the Yjs `prosemirror` XML fragment, serialize the resulting ProseMirror document back to Markdown, format it to canonical Markdown, hash it, and return the encoded Yjs state. The real `flushBranchMarkdownMirror` implementation must serialize the live Yjs/ProseMirror document with Milkdown's serializer before export/read/save boundaries. If this cannot be wired in the first MVP slice, import/branch routes must fail closed or the minimal transaction live writer must include a tested seed-if-empty fallback before AI writes are enabled.

- [ ] **Step 2: Add transformer tests**

Test that the real transformer round-trips headings, tables, code fences, math fences, and frontmatter fixtures, and that the encoded `yjsState` is non-empty and opens as a Yjs document whose `prosemirror` fragment is not empty for non-empty Markdown.

- [ ] **Step 3: Run transformer tests**

Run:

```bash
pnpm test apps/api/src/services/milkdown-transformer.test.ts
```

Expected: PASS. Before the real transformer is wired, tests should assert the seam fails closed with `milkdown_transformer_not_configured`; after the real transformer is wired, fixture round-trip tests should pass.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/milkdown-transformer.ts apps/api/src/services/milkdown-transformer.test.ts
git commit -m "feat: add milkdown transformer seam"
```

### Task 1: Document create service

**Files:**
- Create: `apps/api/src/services/doc-create.ts`

- [ ] **Step 1: Implement create/import service**

Create `apps/api/src/services/doc-create.ts`:

```ts
import type { DbPool } from '../db/client';
import { initializeBranchEditorState } from './milkdown-transformer';

export interface CreateDocInput {
  pool: DbPool;
  title: string;
  markdown: string;
  operation: 'create' | 'import';
}

export async function createDoc(input: CreateDocInput) {
  const initialized = await initializeBranchEditorState(input.markdown);
  const client = await input.pool.connect();
  try {
    await client.query('begin');
    const doc = await client.query('insert into documents (title) values ($1) returning id', [input.title]);
    const docId = (doc.rows[0] as { id: string }).id;

    const branch = await client.query(
      `insert into document_branches (doc_id, name, slug)
       values ($1, 'Main', 'main') returning id`,
      [docId],
    );
    const branchId = (branch.rows[0] as { id: string }).id;

    await client.query(
      `insert into document_branch_states (branch_id, yjs_state, current_markdown, current_hash)
       values ($1, $2, $3, $4)`,
      [branchId, Buffer.from(initialized.yjsState), initialized.markdown, initialized.hash],
    );

    const version = await client.query(
      `insert into document_versions
        (doc_id, branch_id, version_number, markdown_snapshot, hash, actor_type, operation)
       values ($1,$2,1,$3,$4,'user',$5)
       returning id`,
      [docId, branchId, initialized.markdown, initialized.hash, input.operation],
    );
    const versionId = (version.rows[0] as { id: string }).id;

    await client.query('update document_branches set head_version_id = $1 where id = $2', [versionId, branchId]);
    await client.query('update documents set default_branch_id = $1 where id = $2', [branchId, docId]);
    await client.query('commit');

    return { docId, branchId, versionId, hash: initialized.hash };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
```

> **Context note:** The original import flow opened the transaction through the pool and used an empty byte buffer for Yjs state. The corrected code uses one checked-out Postgres client for the transaction and stores Milkdown/Yjs state initialized from the imported Markdown, so agents can safely write before any browser opens the document.

- [ ] **Step 2: Run typecheck**

Run:

```bash
pnpm --filter @marklab/api typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/doc-create.ts
git commit -m "feat: add document create and import service"
```

### Task 2: Canonical branch read service

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

The returned `hash` is the current canonical mirror hash. The returned `versionId` is the branch head version id. These are the `baseHash` and `baseVersionId` an agent receives from `read_doc`.

- [ ] **Step 2: Run typecheck**

Run:

```bash
pnpm --filter @marklab/api typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/doc-read.ts
git commit -m "feat: add canonical branch read service"
```

### Task 3: Import/export routes

**Files:**
- Create: `apps/api/src/routes/import-export-routes.ts`
- Modify: `apps/api/src/http/app.ts`

- [ ] **Step 1: Implement routes**

Create `apps/api/src/routes/import-export-routes.ts`:

```ts
import { Router } from 'express';
import { z } from 'zod';
import { buildExportFilename } from '@marklab/shared/src/export-filename';
import type { DbPool } from '../db/client';
import { createDoc } from '../services/doc-create';
import { readBranchState } from '../services/doc-read';
import { flushBranchMarkdownMirror } from '../services/milkdown-transformer';

const importSchema = z.object({
  title: z.string().min(1),
  markdown: z.string(),
});

const createSchema = z.object({
  title: z.string().min(1),
});

export function createImportExportRoutes(pool: DbPool) {
  const router = Router();

  router.post('/docs', async (req, res, next) => {
    try {
      const body = createSchema.parse(req.body);
      const result = await createDoc({ pool, title: body.title, markdown: '', operation: 'create' });
      res.status(201).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/docs/import', async (req, res, next) => {
    try {
      const body = importSchema.parse(req.body);
      const result = await createDoc({ pool, title: body.title, markdown: body.markdown, operation: 'import' });
      res.status(201).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get('/docs/:docId/branches/:branchId/export.md', async (req, res, next) => {
    try {
      await flushBranchMarkdownMirror(pool, req.params.docId, req.params.branchId);
      const state = await readBranchState(pool, req.params.docId, req.params.branchId);
      const metadata = await pool.query(
        `select d.title, b.slug as branch_slug
           from documents d
           join document_branches b on b.doc_id = d.id
          where d.id = $1 and b.id = $2`,
        [req.params.docId, req.params.branchId],
      );
      const metadataRow = metadata.rows[0] as { title: string; branch_slug: string } | undefined;
      if (!metadataRow) throw new Error('branch_not_found');

      const filename = buildExportFilename({
        title: metadataRow.title,
        docId: state.docId,
        branchSlug: metadataRow.branch_slug,
        versionNumber: state.versionNumber,
        exportedAt: new Date(),
        hash: state.hash,
      });

      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(state.markdown);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
```

`flushBranchMarkdownMirror` must serialize the current live Milkdown/Yjs document through the Milkdown serializer path and update `current_markdown/current_hash` before export. If no reliable server-side serializer is available yet, the route must document that it exports the latest flushed mirror and the web app must flush on blur/page hide/manual save/export boundaries.

> **Context note:** The original export route hard-coded `branchSlug: 'main'` and allowed a query-string title to control the filename. That would generate incorrect filenames for non-main branches. The corrected route reads the document title and branch slug from the database so the filename reflects the exported branch.

- [ ] **Step 2: Mount routes**

Modify `apps/api/src/http/app.ts`:

```ts
import { createImportExportRoutes } from '../routes/import-export-routes';

app.use('/api', createImportExportRoutes(pool));
```

Place it after JSON middleware and before error middleware.

- [ ] **Step 3: Run typecheck**

Run:

```bash
pnpm --filter @marklab/api typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/import-export-routes.ts apps/api/src/http/app.ts
git commit -m "feat: add markdown import and export routes"
```
