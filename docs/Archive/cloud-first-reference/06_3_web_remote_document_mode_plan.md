# Web Remote Document Mode and Browser E2E Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the browser open a real backend document branch and prove two browser windows plus API-originated writes stay synchronized without refresh.

**Architecture:** Keep the existing local editor harness for component testing, but add a product document route backed by Hocuspocus. The route builds room names as `doc:{docId}:branch:{branchId}`, connects through `createEditorCollab`, and passes the provider-backed `ydoc` and `awareness` into `MilkdownEditor`.

**Tech Stack:** React, Vite, Milkdown/Crepe, Yjs, Hocuspocus provider, Express API, Playwright.

---

## Why This Plan Exists Here

Plan 6.2 made the API/live-writer path real, but the web app still has only local editor modes. Plan 7 will add CLI/agent tooling, but it will not create a browser product route. This plan must run before Plan 7 if the MVP needs browser E2E coverage for human collaboration and API/agent writes.

This plan absorbs the unfinished browser-visible API write smoke from Plan 6.2 Task 9 and turns it into a product route plus a real test fixture. Do not skip the browser E2E because the web app lacks a remote-document entry point; this plan creates that entry point.

## File Structure

- Create: `apps/web/src/config.ts` - web API/WebSocket URL config.
- Create: `apps/web/src/routes.ts` - parse and build document routes.
- Create: `apps/web/src/lib/remote-room.ts` - branch room name helper.
- Create: `apps/web/src/pages/RemoteDocumentPage.tsx` - remote document editor page.
- Modify: `apps/web/src/App.tsx` - route between local harness and remote document page.
- Modify: `apps/api/src/collab/server.ts` - expose deterministic flush for active Hocuspocus documents.
- Modify: `apps/api/src/http/app.ts` - flush active collab document before read/write/export/version-sensitive API boundaries.
- Test: `apps/web/tests/remote-document.spec.ts` - two-browser and API-write E2E.
- Modify: `apps/web/playwright.config.ts` - start the web app and, when configured, the API for remote-doc tests.

## Scope Check

This plan creates a minimal real document browser mode. It does not build document list, import/export buttons, version history UI, branch switching UI, or access-control UI; those are Plans 6.4, 6.5, and 6.6.

The local routes remain available:

```text
/                    local single-editor harness
/?collab=two         local two-editor harness
```

The product route added here is:

```text
/docs/:docId/branches/:branchId
```

## Contract Decisions

- The room name is exactly `doc:{docId}:branch:{branchId}`.
- Remote product routes must use `createEditorCollab()` from `apps/web/src/lib/editor-collab.ts`.
- Remote product routes must not create a new local `Y.Doc()` directly.
- The remote page should pass `applyInitialTemplate={false}` to `MilkdownEditor`; import/create/branch flows are responsible for initializing backend Yjs state.
- A provider connection error is a visible page state, not a silent fallback to a local document.
- `VITE_MARKLAB_API_URL` defaults to `http://127.0.0.1:3001`.
- `VITE_MARKLAB_WS_URL` defaults to `ws://127.0.0.1:3001/collab`, matching the API server's WebSocket upgrade path.

## Task 0: Active collaboration flush before API boundaries

**Files:**
- Modify: `apps/api/src/collab/server.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/src/http/app.ts`
- Modify: `apps/api/src/routes/doc-ai-routes.ts`
- Modify: `apps/api/src/routes/import-export-routes.ts`
- Test: `apps/api/src/collab/server.test.ts`
- Test: `apps/api/src/routes/doc-ai-routes.e2e.test.ts`

- [ ] **Step 1: Add active document flush handle**

Modify `createCollabServer(pool)` so it returns both the Hocuspocus server and a `flushDocument(roomName)` function.

Requirements:

```text
Track active Hocuspocus Y.Doc instances by room name.
Track the freshness metadata loaded for each active Y.Doc.
flushDocument(roomName) encodes the active Y.Doc with Y.encodeStateAsUpdate(document).
flushDocument(roomName) calls storeYjsState with the active document's latest freshness metadata.
If the store succeeds, update the active document metadata.
If no active document exists for the room, flushDocument is a no-op.
If a stale store is detected, reload the latest DB state, apply it into the active Y.Doc, retry once, and keep refreshed metadata.
```

Do not rely on Hocuspocus' eventual store timing for API read/write/export correctness.

- [ ] **Step 2: Flush before REST document boundaries**

Thread the flush handle into HTTP route creation:

```ts
createHttpApp(pool, liveWriter, { flushCollabDocument })
```

Before these operations read or serialize branch state, call:

```ts
await flushCollabDocument(toRoomName(docId, branchId));
```

Required boundaries:

```text
read_doc
write_doc
edit_doc
export.md
restore-as-new-version from Plan 6.5
```

Version list/show do not need to flush unless the route returns current branch state rather than immutable version rows.

- [ ] **Step 3: Add active-flush tests**

Add tests proving:

```text
read_doc sees an edit that exists in an active Hocuspocus Y.Doc before the normal store timer runs.
write_doc checks baseHash against the active Yjs state after active flush, not stale Postgres bytes.
export uses the active flushed state for body, filename version, and hash.
```

- [ ] **Step 4: Run API tests**

Run:

```bash
npx -y pnpm@10.0.0 test apps/api/src/collab/server.test.ts apps/api/src/routes/doc-ai-routes.e2e.test.ts apps/api/src/routes/import-export-routes.export.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/collab/server.ts apps/api/src/index.ts apps/api/src/http/app.ts apps/api/src/routes/doc-ai-routes.ts apps/api/src/routes/import-export-routes.ts apps/api/src/collab/server.test.ts apps/api/src/routes/doc-ai-routes.e2e.test.ts apps/api/src/routes/import-export-routes.export.test.ts
git commit -m "feat: flush active collab docs before api reads"
```

## Task 1: Web route and config helpers

**Files:**
- Create: `apps/web/src/config.ts`
- Create: `apps/web/src/routes.ts`
- Create: `apps/web/src/lib/remote-room.ts`

- [ ] **Step 1: Add web config helper**

Create `apps/web/src/config.ts`:

```ts
export interface WebConfig {
  apiUrl: string;
  websocketUrl: string;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, '');
}

export function readWebConfig(env: ImportMetaEnv = import.meta.env): WebConfig {
  return {
    apiUrl: trimTrailingSlash(env.VITE_MARKLAB_API_URL ?? 'http://127.0.0.1:3001'),
    websocketUrl: trimTrailingSlash(env.VITE_MARKLAB_WS_URL ?? 'ws://127.0.0.1:3001/collab'),
  };
}
```

- [ ] **Step 2: Add route helpers**

Create `apps/web/src/routes.ts`:

```ts
export interface RemoteDocumentRoute {
  kind: 'remote-document';
  docId: string;
  branchId: string;
}

export interface LocalHarnessRoute {
  kind: 'local-single' | 'local-two';
}

export type AppRoute = RemoteDocumentRoute | LocalHarnessRoute;

const remoteDocumentPattern = /^\/docs\/([^/]+)\/branches\/([^/]+)$/u;

export function parseAppRoute(location: Pick<Location, 'pathname' | 'search'>): AppRoute {
  const match = location.pathname.match(remoteDocumentPattern);
  if (match) {
    return {
      kind: 'remote-document',
      docId: decodeURIComponent(match[1]),
      branchId: decodeURIComponent(match[2]),
    };
  }

  const params = new URLSearchParams(location.search);
  if (params.get('collab') === 'two') return { kind: 'local-two' };

  const queryDocId = params.get('docId');
  const queryBranchId = params.get('branchId');
  if (queryDocId && queryBranchId) {
    return { kind: 'remote-document', docId: queryDocId, branchId: queryBranchId };
  }

  return { kind: 'local-single' };
}

export function buildDocumentPath(docId: string, branchId: string): string {
  return `/docs/${encodeURIComponent(docId)}/branches/${encodeURIComponent(branchId)}`;
}
```

- [ ] **Step 3: Add room helper**

Create `apps/web/src/lib/remote-room.ts`:

```ts
export function buildBranchRoomName(docId: string, branchId: string): string {
  if (!docId) throw new Error('missing_doc_id');
  if (!branchId) throw new Error('missing_branch_id');
  return `doc:${docId}:branch:${branchId}`;
}
```

- [ ] **Step 4: Run typecheck**

Run:

```bash
npx -y pnpm@10.0.0 --filter @marklab/web typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/config.ts apps/web/src/routes.ts apps/web/src/lib/remote-room.ts
git commit -m "feat: add web remote document routing helpers"
```

## Task 2: Remote document page

**Files:**
- Create: `apps/web/src/pages/RemoteDocumentPage.tsx`
- Modify: `apps/web/src/App.tsx`

- [ ] **Step 1: Create remote document page**

Create `apps/web/src/pages/RemoteDocumentPage.tsx`:

```tsx
import { useEffect, useMemo, useState } from 'react';
import type { Awareness } from 'y-protocols/awareness';
import type * as Y from 'yjs';
import { MilkdownEditor } from '../components/MilkdownEditor';
import { readWebConfig } from '../config';
import { createEditorCollab } from '../lib/editor-collab';
import { buildBranchRoomName } from '../lib/remote-room';

interface RemoteDocumentPageProps {
  docId: string;
  branchId: string;
}

interface RemoteCollabState {
  ydoc: Y.Doc;
  awareness: Awareness;
  destroy: () => void;
}

export function RemoteDocumentPage({ docId, branchId }: RemoteDocumentPageProps) {
  const config = useMemo(() => readWebConfig(), []);
  const roomName = useMemo(() => buildBranchRoomName(docId, branchId), [branchId, docId]);
  const [collab, setCollab] = useState<RemoteCollabState | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  useEffect(() => {
    setConnectionError(null);
    const remote = createEditorCollab({
      websocketUrl: config.websocketUrl,
      roomName,
      user: { name: 'Human Writer', color: '#2563eb' },
    });

    const provider = remote.provider;
    const handleStatus = ({ status }: { status: string }) => {
      if (status === 'disconnected') setConnectionError('disconnected');
    };
    provider.on('status', handleStatus);
    setCollab(remote);

    return () => {
      provider.off('status', handleStatus);
      remote.destroy();
      setCollab(null);
    };
  }, [config.websocketUrl, roomName]);

  return (
    <main className="app-shell" data-testid="remote-document-page">
      <header className="app-header">
        <h1>MarkLab</h1>
        <span data-testid="remote-document-id">{docId}</span>
      </header>
      {connectionError ? <p role="alert">Connection lost</p> : null}
      {collab ? (
        <MilkdownEditor
          initialMarkdown=""
          ydoc={collab.ydoc}
          awareness={collab.awareness}
          applyInitialTemplate={false}
          testId="milkdown-editor"
        />
      ) : (
        <p>Opening document...</p>
      )}
    </main>
  );
}
```

- [ ] **Step 2: Wire app routing**

Modify `apps/web/src/App.tsx` so `App()` uses `parseAppRoute(window.location)`:

```tsx
export function App() {
  const route = parseAppRoute(window.location);

  if (route.kind === 'remote-document') {
    return <RemoteDocumentPage docId={route.docId} branchId={route.branchId} />;
  }

  if (route.kind === 'local-two') return <TwoEditorCollabHarness />;

  return <SingleEditorWorkspace />;
}
```

Keep `SingleEditorWorkspace` and `TwoEditorCollabHarness` unchanged except for any imports needed by the new route.

- [ ] **Step 3: Run typecheck**

Run:

```bash
npx -y pnpm@10.0.0 --filter @marklab/web typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/App.tsx apps/web/src/pages/RemoteDocumentPage.tsx
git commit -m "feat: add remote document web page"
```

## Task 3: Browser E2E for real backend documents

**Files:**
- Create: `apps/web/tests/remote-document.spec.ts`
- Create: `apps/web/tests/setup-remote-api.ts`
- Modify: `apps/web/playwright.config.ts`

- [ ] **Step 1: Add remote API database setup**

Create `apps/web/tests/setup-remote-api.ts` for remote-document E2E. It must:

```text
require TEST_DATABASE_URL unless MARKLAB_E2E_ALLOW_EXISTING_API=true;
refuse to run if TEST_DATABASE_URL does not contain "_test" or "localhost"/"127.0.0.1";
connect with pg;
drop and recreate public schema for that test database;
run apps/api/src/db/schema.sql;
close the connection.
```

Add `pg` and `@types/pg` as `devDependencies` of `apps/web/package.json` if the setup file imports `pg` directly. This is test-only and avoids relying on Plan 8.1's later schema script.

- [ ] **Step 2: Add Playwright server configuration**

Modify `apps/web/playwright.config.ts` so it can start both the web app and API in remote-doc tests. Use `TEST_DATABASE_URL` for API tests. If `TEST_DATABASE_URL` is missing, remote-doc tests should fail with a setup error that names the missing variable.

Expected server config shape:

```ts
webServer: [
  {
    command: `VITE_MARKLAB_API_URL=http://127.0.0.1:3001 VITE_MARKLAB_WS_URL=ws://127.0.0.1:3001/collab pnpm exec vite --host 127.0.0.1 --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: true,
  },
  {
    command: 'DATABASE_URL=$TEST_DATABASE_URL pnpm --filter @marklab/api dev',
    url: 'http://127.0.0.1:3001/healthz',
    reuseExistingServer: true,
  },
]
```

Set `globalSetup: './tests/setup-remote-api.ts'`. Adjust quoting for the shell used by Playwright on the target platform.

- [ ] **Step 3: Add remote document E2E**

Create `apps/web/tests/remote-document.spec.ts` with this flow:

```ts
import { expect, test } from '@playwright/test';

const apiUrl = process.env.MARKLAB_E2E_API_URL ?? 'http://127.0.0.1:3001';

test('two windows open the same backend document and see API writes without refresh', async ({ browser, request }) => {
  if (!process.env.TEST_DATABASE_URL && !process.env.MARKLAB_E2E_ALLOW_EXISTING_API) {
    throw new Error('TEST_DATABASE_URL is required for remote document E2E');
  }

  const imported = await request.post(`${apiUrl}/api/docs/import`, {
    data: {
      title: 'Remote E2E',
      markdown: '# Remote E2E\n\nOriginal paragraph.\n',
    },
  });
  expect(imported.ok()).toBeTruthy();
  const doc = await imported.json();

  const path = `/docs/${doc.docId}/branches/${doc.branchId}`;
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  await pageA.goto(path);
  await pageB.goto(path);

  const editorA = pageA.getByTestId('milkdown-editor').locator('.ProseMirror');
  const editorB = pageB.getByTestId('milkdown-editor').locator('.ProseMirror');

  await expect(editorA).toContainText('Remote E2E');
  await expect(editorB).toContainText('Remote E2E');

  await editorA.click();
  await pageA.keyboard.press('End');
  await pageA.keyboard.press('Enter');
  await pageA.keyboard.type('Browser A edit.');
  await expect(editorB).toContainText('Browser A edit.');

  const read = await request.get(`${apiUrl}/api/docs/${doc.docId}/branches/${doc.branchId}/read`);
  expect(read.ok()).toBeTruthy();
  const base = await read.json();

  const write = await request.post(`${apiUrl}/api/docs/${doc.docId}/branches/${doc.branchId}/write`, {
    data: {
      baseVersionId: base.versionId,
      baseHash: base.hash,
      markdown: `${base.markdown}\nAPI write visible.\n`,
    },
  });
  expect(write.ok()).toBeTruthy();

  await expect(editorA).toContainText('API write visible.');
  await expect(editorB).toContainText('API write visible.');

  await contextA.close();
  await contextB.close();
});
```

- [ ] **Step 4: Run browser tests**

Run:

```bash
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/marklab_test npx -y pnpm@10.0.0 --filter @marklab/web test:e2e
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/package.json pnpm-lock.yaml apps/web/playwright.config.ts apps/web/tests/setup-remote-api.ts apps/web/tests/remote-document.spec.ts
git commit -m "test: verify remote document browser sync"
```

## Task 4: Final verification

**Files:**
- Review all changed files.

- [ ] **Step 1: Run full test suite**

Run:

```bash
npx -y pnpm@10.0.0 test
```

Expected: PASS.

- [ ] **Step 2: Run full typecheck**

Run:

```bash
npx -y pnpm@10.0.0 typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit any final fixes**

```bash
git status --short
git add apps/web/src apps/web/tests apps/web/playwright.config.ts
git commit -m "test: complete remote document mode"
```

Skip this commit when `git status --short` is clean after earlier commits.

## Deployment Gate After This Plan

Before Plan 6.4 starts, these checks must be true:

```text
/docs/:docId/branches/:branchId opens a real backend document.
Two browser contexts connected to the same route converge through Hocuspocus.
The route does not fall back to a local Y.Doc on connection failure.
API write_doc/edit_doc changes become visible in connected browsers without refresh.
API read/write/export observe active browser edits without waiting for eventual Hocuspocus persistence.
The local / and /?collab=two harness routes still pass existing Playwright tests.
```
