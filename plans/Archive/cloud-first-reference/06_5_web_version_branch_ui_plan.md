# Web Version History, Branch, and Restore UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose version history, branch switching, branch-from-version, and restore-as-new-version in the Web UI.

**Architecture:** Reuse the backend version service from Plan 5, add missing document/branch metadata routes, and add restore through the same live writer path as AI writes so connected browsers update without refresh. The UI remains list-based for MVP; it does not render a graph visualization.

**Tech Stack:** Express, Postgres, React, Milkdown/Crepe, Playwright, Vitest.

---

## Why This Plan Exists Here

The MVP scope says version history and branching are product features, but Plan 5 only implemented backend primitives. A launchable browser MVP needs users to see history, inspect version Markdown, branch from an older version, switch branches, and restore a selected version as a new head without deleting history.

## File Structure

- Modify: `apps/api/src/services/version-service.ts` - add branch list helpers.
- Modify: `apps/api/src/services/editor-state.ts` - add restore-as-version support through the live writer.
- Modify: `apps/api/src/routes/version-routes.ts` - add document metadata, branch list, and restore route.
- Test: `apps/api/src/routes/version-routes.test.ts`.
- Modify: `apps/web/src/lib/api-client.ts` - version and branch API methods.
- Create: `apps/web/src/components/VersionHistoryPanel.tsx` - list/show/branch/restore UI.
- Create: `apps/web/src/components/BranchSwitcher.tsx` - switch branches for current doc.
- Modify: `apps/web/src/pages/RemoteDocumentPage.tsx` - mount version and branch UI.
- Test: `apps/web/tests/version-branch-ui.spec.ts`.

## Scope Check

This plan implements simple version and branch UI. It does not implement visual graph layout, branch deletion, permanent version deletion, comments, or in-app AI diff review.

## API Additions

```http
GET /api/docs/:docId
GET /api/docs/:docId/branches
POST /api/docs/:docId/branches/:branchId/restore
```

`POST /api/docs/:docId/branches/:branchId/restore` creates a new version on the selected branch whose content equals the requested source version. It must update the current branch through the concrete live writer, persist the returned non-empty encoded Yjs state with the canonical mirror, and create a `rollback` version. Directly replacing `document_branch_states.yjs_state` in Postgres is not enough because already-connected Hocuspocus clients would not receive the change.

## Task 1: Document and branch metadata API

**Files:**
- Modify: `apps/api/src/services/version-service.ts`
- Modify: `apps/api/src/routes/version-routes.ts`
- Test: `apps/api/src/routes/version-routes.test.ts`

- [ ] **Step 1: Add branch metadata helpers**

Append helpers to `apps/api/src/services/version-service.ts`:

```ts
export async function getDocumentSummary(pool: DbPool, docId: string) {
  const result = await pool.query(
    `select d.id, d.title, d.default_branch_id
       from documents d
      where d.id = $1`,
    [docId],
  );
  const row = result.rows[0] as { id: string; title: string; default_branch_id: string | null } | undefined;
  if (!row) throw new Error('document_not_found');
  return { docId: row.id, title: row.title, defaultBranchId: row.default_branch_id };
}

export async function listBranches(pool: DbPool, docId: string) {
  const result = await pool.query(
    `select b.id, b.name, b.slug, b.head_version_id, b.created_from_version_id, b.is_archived, v.version_number
       from document_branches b
       left join document_versions v on v.id = b.head_version_id
      where b.doc_id = $1
      order by b.created_at asc`,
    [docId],
  );
  return result.rows.map((row) => ({
    branchId: row.id as string,
    name: row.name as string,
    slug: row.slug as string,
    headVersionId: row.head_version_id as string | null,
    createdFromVersionId: row.created_from_version_id as string | null,
    isArchived: row.is_archived as boolean,
    headVersionNumber: row.version_number as number | null,
  }));
}
```

- [ ] **Step 2: Add metadata routes**

Modify `apps/api/src/routes/version-routes.ts`:

```ts
router.get('/docs/:docId', async (req, res, next) => {
  try {
    const docId = requiredParam(req, 'docId');
    const [doc, branches] = await Promise.all([getDocumentSummary(pool, docId), listBranches(pool, docId)]);
    res.json({ ...doc, branches });
  } catch (error) {
    next(error);
  }
});

router.get('/docs/:docId/branches', async (req, res, next) => {
  try {
    const docId = requiredParam(req, 'docId');
    res.json({ branches: await listBranches(pool, docId) });
  } catch (error) {
    next(error);
  }
});
```

Also extend the HTTP error handler to return `404 { error: "document_not_found" }`.

- [ ] **Step 3: Add route tests**

Update `apps/api/src/routes/version-routes.test.ts` to assert:

```text
GET /api/docs/:docId returns title, defaultBranchId, and branches.
GET /api/docs/:docId/branches returns branch ids, slugs, and head version numbers.
GET /api/docs/:missing returns 404 document_not_found.
```

- [ ] **Step 4: Run API route tests**

Run:

```bash
npx -y pnpm@10.0.0 test apps/api/src/routes/version-routes.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/version-service.ts apps/api/src/routes/version-routes.ts apps/api/src/routes/version-routes.test.ts apps/api/src/http/app.ts
git commit -m "feat: add document branch metadata routes"
```

## Task 2: Restore-as-new-version route

**Files:**
- Modify: `apps/api/src/services/editor-state.ts`
- Modify: `apps/api/src/routes/version-routes.ts`
- Test: `apps/api/src/routes/version-routes.test.ts`

- [ ] **Step 1: Add restore operation support**

Extend `apps/api/src/services/live-writer.ts` and `apps/api/src/services/editor-state.ts` so `applyMarkdownToBranchState` can create a version with operation `rollback`.

Requirements:

```text
Load the source version for the same doc.
Flush the current target branch live state before restore.
If the flushed live hash differs from branch head, create a system manual_save checkpoint first.
Use LiveMarkdownWriter to apply the source version Markdown to the current live branch state.
Persist the writer's returned non-empty yjsState, serializedMarkdown, hash, and yjs_state_fingerprint in one transaction.
Create a new document_versions row with operation rollback and parent_version_id set to the checkpoint or previous head.
Return versionId, versionNumber, hash.
```

For unopened branches, the concrete live writer's seed-if-empty behavior remains the fallback. Do not restore by direct DB-only Yjs replacement on an active branch.

- [ ] **Step 2: Add restore route**

Add route:

```http
POST /api/docs/:docId/branches/:branchId/restore
```

Request:

```json
{
  "versionId": "ver_012"
}
```

Response:

```json
{
  "versionId": "ver_044",
  "versionNumber": 44,
  "hash": "sha256:..."
}
```

The route must receive the same `LiveMarkdownWriter` that write/edit routes use. Modify `createVersionRoutes(pool, liveWriter)` and `createHttpApp(pool, liveWriter)` rather than constructing a second writer.

- [ ] **Step 3: Add restore tests**

Update route tests to prove:

```text
Restore creates a new version with operation rollback.
Restore updates the branch head.
Restore persists the live writer's returned yjsState and yjs_state_fingerprint.
Restore creates a checkpoint first when current live state is dirty relative to head.
Restore does not delete or mutate the source version.
Restore rejects source versions from another doc.
Restore returns 503 when the live writer is unavailable.
```

- [ ] **Step 4: Run tests**

Run:

```bash
npx -y pnpm@10.0.0 test apps/api/src/routes/version-routes.test.ts apps/api/src/services/version-service.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/editor-state.ts apps/api/src/services/live-writer.ts apps/api/src/routes/version-routes.ts apps/api/src/routes/version-routes.test.ts apps/api/src/http/app.ts
git commit -m "feat: add restore version route"
```

## Task 3: Web version and branch client

**Files:**
- Modify: `apps/web/src/lib/api-client.ts`

- [ ] **Step 1: Add client methods**

Add methods to `MarklabWebApi`:

```ts
async getDocument(docId: string): Promise<DocumentSummary>;
async listBranches(docId: string): Promise<{ branches: BranchSummary[] }>;
async listVersions(docId: string, branchId: string): Promise<{ versions: VersionSummary[] }>;
async showVersion(docId: string, versionId: string): Promise<VersionDetail>;
async branchFromVersion(docId: string, versionId: string, name: string): Promise<{ branchId: string; headVersionId: string }>;
async restoreVersion(docId: string, branchId: string, versionId: string): Promise<{ versionId: string; versionNumber: number; hash: string }>;
```

Use the route paths from Plan 5 and this plan. Throw `request_failed:<status>:<body>` on non-2xx responses.

- [ ] **Step 2: Run typecheck**

Run:

```bash
npx -y pnpm@10.0.0 --filter @marklab/web typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/api-client.ts
git commit -m "feat: add web version api client"
```

## Task 4: Branch switcher and version panel

**Files:**
- Create: `apps/web/src/components/BranchSwitcher.tsx`
- Create: `apps/web/src/components/VersionHistoryPanel.tsx`
- Modify: `apps/web/src/pages/RemoteDocumentPage.tsx`

- [ ] **Step 1: Add branch switcher**

Create `BranchSwitcher` that:

```text
Loads branches for docId.
Shows current branch by slug/name.
Navigates to /docs/:docId/branches/:selectedBranchId on change.
Marks archived branches as disabled.
```

- [ ] **Step 2: Add version history panel**

Create `VersionHistoryPanel` that:

```text
Loads versions for current docId and branchId.
Shows version number, operation, actor type, created time, and hash prefix.
Loads selected version detail with markdown preview.
Has Branch from this version action.
Has Restore this version action with confirmation text.
Refreshes versions after restore.
Navigates to the new branch after branch-from-version.
```

- [ ] **Step 3: Mount UI**

Modify `RemoteDocumentPage` to render `BranchSwitcher` and `VersionHistoryPanel` beside the editor. Keep the editor usable on narrow screens by stacking the panel below the editor.

- [ ] **Step 4: Run typecheck**

Run:

```bash
npx -y pnpm@10.0.0 --filter @marklab/web typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/BranchSwitcher.tsx apps/web/src/components/VersionHistoryPanel.tsx apps/web/src/pages/RemoteDocumentPage.tsx
git commit -m "feat: add web version history ui"
```

## Task 5: Version UI E2E

**Files:**
- Create: `apps/web/tests/version-branch-ui.spec.ts`

- [ ] **Step 1: Add browser test**

Create a Playwright test that:

1. imports a document through the API;
2. opens the remote document page;
3. uses `edit_doc` through the API to create a second version;
4. opens the version panel and sees version 1 and version 2;
5. previews version 1 Markdown;
6. branches from version 1 and verifies the browser navigates to the new branch;
7. returns to the original branch and restores version 1 as a new head;
8. verifies version list contains operation `rollback`.

- [ ] **Step 2: Run browser tests**

Run:

```bash
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/marklab_test npx -y pnpm@10.0.0 --filter @marklab/web test:e2e
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/tests/version-branch-ui.spec.ts
git commit -m "test: verify web version branch ui"
```

## Deployment Gate After This Plan

Before Plan 6.6 starts, these checks must be true:

```text
Users can see version history in the browser.
Users can preview old version Markdown.
Users can branch from an old version.
Users can switch branches.
Users can restore an old version as a new head without deleting history.
Remote editor state matches the selected branch after branch switch or restore.
```
