# Import and Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to create cloud docs from local Markdown and export cloud docs as metadata-rich snapshot files.

**Architecture:** Import canonicalizes Markdown, initializes branch state, and creates v1. Export reads canonical mirror and builds a filename that warns the file is an export snapshot.

**Tech Stack:** Express, Postgres, Prettier markdown formatter, shared export filename builder.

---

## File Structure

- Create: `apps/api/src/services/doc-create.ts` — blank/import create flows.
- Create: `apps/api/src/routes/import-export-routes.ts` — import/export HTTP endpoints.
- Modify: `apps/api/src/http/app.ts` — mount import/export routes.
- Test: `apps/api/src/routes/import-export-routes.test.ts`.

## Scope Check

This plan does not implement local sync. It only implements upload/import and snapshot export.

### Task 1: Document create service

**Files:**
- Create: `apps/api/src/services/doc-create.ts`

- [ ] **Step 1: Implement create/import service**

Create `apps/api/src/services/doc-create.ts`:

```ts
import { canonicalizeMarkdown } from '@mdcollab/markdown/src/canonicalize';
import { sha256Hex } from '@mdcollab/shared/src/hash';
import { createEmptyYjsState } from '../collab/persistence';
import type { DbPool } from '../db/client';

export interface CreateDocInput {
  pool: DbPool;
  title: string;
  markdown: string;
  operation: 'create' | 'import';
}

export async function createDoc(input: CreateDocInput) {
  const markdown = await canonicalizeMarkdown(input.markdown);
  const hash = sha256Hex(markdown);
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
      [branchId, Buffer.from(createEmptyYjsState()), markdown, hash],
    );

    const version = await client.query(
      `insert into document_versions
        (doc_id, branch_id, version_number, markdown_snapshot, hash, actor_type, operation)
       values ($1,$2,1,$3,$4,'user',$5)
       returning id`,
      [docId, branchId, markdown, hash, input.operation],
    );
    const versionId = (version.rows[0] as { id: string }).id;

    await client.query('update document_branches set head_version_id = $1 where id = $2', [versionId, branchId]);
    await client.query('update documents set default_branch_id = $1 where id = $2', [branchId, docId]);
    await client.query('commit');

    return { docId, branchId, versionId, hash };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
```

> **Context note:** The original import flow opened the transaction through the pool and used an empty byte buffer for Yjs state. The corrected code uses one checked-out Postgres client for the transaction and stores a valid encoded empty Yjs update so the first editor load can safely apply collaboration state.

- [ ] **Step 2: Run typecheck**

Run:

```bash
pnpm --filter @mdcollab/api typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/doc-create.ts
git commit -m "feat: add document create and import service"
```

### Task 2: Import/export routes

**Files:**
- Create: `apps/api/src/routes/import-export-routes.ts`
- Modify: `apps/api/src/http/app.ts`

- [ ] **Step 1: Implement routes**

Create `apps/api/src/routes/import-export-routes.ts`:

```ts
import { Router } from 'express';
import { z } from 'zod';
import { buildExportFilename } from '@mdcollab/shared/src/export-filename';
import type { DbPool } from '../db/client';
import { createDoc } from '../services/doc-create';
import { readBranchState } from '../services/doc-read';

const importSchema = z.object({
  title: z.string().min(1),
  markdown: z.string(),
});

export function createImportExportRoutes(pool: DbPool) {
  const router = Router();

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
pnpm --filter @mdcollab/api typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/import-export-routes.ts apps/api/src/http/app.ts
git commit -m "feat: add markdown import and export routes"
```
