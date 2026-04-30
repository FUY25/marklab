# Web Document Lifecycle UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the minimal Web UI for creating, importing, opening, and exporting Markdown cloud documents.

**Architecture:** Build a quiet document workspace shell around the remote document route from Plan 6.3. The browser calls existing create/import/export APIs, stores recent documents in local storage for MVP navigation, and opens real document URLs after creation or import.

**Tech Stack:** React, Vite, Express REST API, browser File API, Playwright.

---

## Why This Plan Exists Here

The product requirements include blank document creation, local Markdown import, and export snapshots. The backend APIs exist, but the web app does not yet expose those flows. Without this plan, a tester can only open documents by manually copying `docId` and `branchId` into a URL.

## File Structure

- Create: `apps/web/src/lib/api-client.ts` - typed browser API client.
- Create: `apps/web/src/lib/recent-documents.ts` - local recent-document storage.
- Create: `apps/web/src/pages/HomePage.tsx` - new/import/open entry page.
- Create: `apps/web/src/components/DocumentToolbar.tsx` - title, export, link copy, status area.
- Modify: `apps/web/src/pages/RemoteDocumentPage.tsx` - add toolbar and export action.
- Modify: `apps/web/src/App.tsx` - use `HomePage` for the root product route while preserving `/?collab=two`.
- Test: `apps/web/tests/document-lifecycle.spec.ts`.

## Scope Check

This plan is a minimal product shell. It does not add version history UI, branch switching, token management, or a full workspace dashboard. Recent documents are stored locally so the MVP can navigate without implementing user accounts first.

## Product Requirements

- Root route `/` shows product actions, not only a demo editor.
- A user can create a blank doc and land on `/docs/:docId/branches/:branchId`.
- A user can import a `.md` file and land on the imported document.
- A user can paste or type `docId` and `branchId` to open an existing document.
- A user can export the current document as `.md`; the browser download filename must come from `Content-Disposition`.
- Export failures surface the server error, including `export_version_mismatch`.
- The local harness stays available at `/?local=one` and `/?collab=two` for tests and development. Existing Playwright tests from Plan 2/6.3 that expect the local single editor must be updated from `/` to `/?local=one`.

## Task 1: Browser API client

**Files:**
- Create: `apps/web/src/lib/api-client.ts`

- [ ] **Step 1: Add API client**

Create `apps/web/src/lib/api-client.ts`:

```ts
import { readWebConfig } from '../config';

export interface CreatedDocument {
  docId: string;
  branchId: string;
  versionId: string;
  hash: string;
}

export class MarklabWebApi {
  constructor(private readonly apiUrl = readWebConfig().apiUrl) {}

  async createBlankDoc(title: string): Promise<CreatedDocument> {
    return this.postJson('/api/docs', { title });
  }

  async importMarkdown(title: string, markdown: string): Promise<CreatedDocument> {
    return this.postJson('/api/docs/import', { title, markdown });
  }

  async exportMarkdown(docId: string, branchId: string): Promise<{ filename: string; markdown: string }> {
    const response = await fetch(`${this.apiUrl}/api/docs/${encodeURIComponent(docId)}/branches/${encodeURIComponent(branchId)}/export.md`);
    if (!response.ok) throw new Error(`export_failed:${response.status}:${await response.text()}`);
    const disposition = response.headers.get('content-disposition') ?? '';
    return {
      filename: parseContentDispositionFilename(disposition) ?? 'marklab-export.md',
      markdown: await response.text(),
    };
  }

  private async postJson<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${this.apiUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`request_failed:${response.status}:${await response.text()}`);
    return response.json() as Promise<T>;
  }
}

export function parseContentDispositionFilename(disposition: string): string | null {
  const match = disposition.match(/filename="([^"]+)"/u);
  return match?.[1] ?? null;
}
```

- [ ] **Step 2: Run typecheck**

Run:

```bash
npx -y pnpm@10.0.0 --filter @marklab/web typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/api-client.ts
git commit -m "feat: add web api client"
```

## Task 2: Recent document storage and home page

**Files:**
- Create: `apps/web/src/lib/recent-documents.ts`
- Create: `apps/web/src/pages/HomePage.tsx`
- Modify: `apps/web/src/App.tsx`

- [ ] **Step 1: Add recent document storage**

Create `apps/web/src/lib/recent-documents.ts`:

```ts
export interface RecentDocument {
  docId: string;
  branchId: string;
  title: string;
  openedAt: string;
}

const storageKey = 'marklab.recentDocuments.v1';

export function loadRecentDocuments(storage: Storage = localStorage): RecentDocument[] {
  const raw = storage.getItem(storageKey);
  if (!raw) return [];
  const parsed = JSON.parse(raw) as RecentDocument[];
  return parsed.filter((item) => item.docId && item.branchId && item.title);
}

export function rememberRecentDocument(document: Omit<RecentDocument, 'openedAt'>, storage: Storage = localStorage): RecentDocument[] {
  const next: RecentDocument = { ...document, openedAt: new Date().toISOString() };
  const existing = loadRecentDocuments(storage).filter((item) => item.docId !== document.docId || item.branchId !== document.branchId);
  const documents = [next, ...existing].slice(0, 10);
  storage.setItem(storageKey, JSON.stringify(documents));
  return documents;
}
```

- [ ] **Step 2: Add home page**

Create `apps/web/src/pages/HomePage.tsx` with:

```tsx
import { FormEvent, useMemo, useState } from 'react';
import { buildDocumentPath } from '../routes';
import { MarklabWebApi } from '../lib/api-client';
import { loadRecentDocuments, rememberRecentDocument } from '../lib/recent-documents';

export function HomePage() {
  const api = useMemo(() => new MarklabWebApi(), []);
  const [title, setTitle] = useState('Untitled');
  const [docId, setDocId] = useState('');
  const [branchId, setBranchId] = useState('');
  const [recent, setRecent] = useState(() => loadRecentDocuments());
  const [error, setError] = useState<string | null>(null);

  async function createBlank() {
    setError(null);
    const created = await api.createBlankDoc(title.trim() || 'Untitled');
    rememberRecentDocument({ docId: created.docId, branchId: created.branchId, title: title.trim() || 'Untitled' });
    window.location.assign(buildDocumentPath(created.docId, created.branchId));
  }

  async function importFile(file: File) {
    setError(null);
    const markdown = await file.text();
    const imported = await api.importMarkdown(file.name.replace(/\.md$/iu, ''), markdown);
    rememberRecentDocument({ docId: imported.docId, branchId: imported.branchId, title: file.name });
    window.location.assign(buildDocumentPath(imported.docId, imported.branchId));
  }

  function openExisting(event: FormEvent) {
    event.preventDefault();
    if (!docId || !branchId) {
      setError('Document id and branch id are required.');
      return;
    }
    setRecent(rememberRecentDocument({ docId, branchId, title: docId }));
    window.location.assign(buildDocumentPath(docId, branchId));
  }

  return (
    <main className="app-shell" data-testid="home-page">
      <header className="app-header">
        <h1>MarkLab</h1>
      </header>
      {error ? <p role="alert">{error}</p> : null}
      <section aria-label="Create document">
        <input value={title} onChange={(event) => setTitle(event.target.value)} aria-label="Document title" />
        <button type="button" onClick={() => void createBlank()}>New Markdown Doc</button>
        <input
          aria-label="Import Markdown"
          type="file"
          accept=".md,text/markdown,text/plain"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void importFile(file);
          }}
        />
      </section>
      <form onSubmit={openExisting} aria-label="Open document">
        <input value={docId} onChange={(event) => setDocId(event.target.value)} aria-label="Document id" />
        <input value={branchId} onChange={(event) => setBranchId(event.target.value)} aria-label="Branch id" />
        <button type="submit">Open</button>
      </form>
      <section aria-label="Recent documents">
        {recent.map((item) => (
          <a key={`${item.docId}:${item.branchId}`} href={buildDocumentPath(item.docId, item.branchId)}>
            {item.title}
          </a>
        ))}
      </section>
    </main>
  );
}
```

- [ ] **Step 3: Route root to home page**

Modify `apps/web/src/routes.ts` and `apps/web/src/App.tsx` so root `/` renders `HomePage`, `/?local=one` renders the local single-editor harness, and `/?collab=two` keeps the local collaboration harness.

The route type should become:

```ts
export type AppRoute = RemoteDocumentRoute | LocalHarnessRoute | { kind: 'home' };
```

`parseAppRoute()` should return `{ kind: 'home' }` for `/` with no `local=one`, no `collab=two`, and no `docId/branchId`.

- [ ] **Step 4: Run typecheck**

Run:

```bash
npx -y pnpm@10.0.0 --filter @marklab/web typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/App.tsx apps/web/src/pages/HomePage.tsx apps/web/src/lib/recent-documents.ts
git commit -m "feat: add web document home page"
```

## Task 3: Remote document toolbar and export

**Files:**
- Create: `apps/web/src/components/DocumentToolbar.tsx`
- Modify: `apps/web/src/pages/RemoteDocumentPage.tsx`

- [ ] **Step 1: Add document toolbar**

Create `apps/web/src/components/DocumentToolbar.tsx`:

```tsx
import { useMemo, useState } from 'react';
import { MarklabWebApi } from '../lib/api-client';

interface DocumentToolbarProps {
  docId: string;
  branchId: string;
}

export function DocumentToolbar({ docId, branchId }: DocumentToolbarProps) {
  const api = useMemo(() => new MarklabWebApi(), []);
  const [status, setStatus] = useState<string | null>(null);

  async function exportDoc() {
    setStatus('Exporting...');
    try {
      const exported = await api.exportMarkdown(docId, branchId);
      const blob = new Blob([exported.markdown], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = exported.filename;
      link.click();
      URL.revokeObjectURL(url);
      setStatus('Exported');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Export failed');
    }
  }

  return (
    <div className="document-toolbar">
      <a href="/">Documents</a>
      <button type="button" onClick={() => void navigator.clipboard.writeText(window.location.href)}>Copy link</button>
      <button type="button" onClick={() => void exportDoc()}>Export Markdown</button>
      {status ? <span role="status">{status}</span> : null}
    </div>
  );
}
```

- [ ] **Step 2: Mount toolbar**

Modify `RemoteDocumentPage` so it renders:

```tsx
<DocumentToolbar docId={docId} branchId={branchId} />
```

inside the page header or immediately below it.

- [ ] **Step 3: Run typecheck**

Run:

```bash
npx -y pnpm@10.0.0 --filter @marklab/web typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/DocumentToolbar.tsx apps/web/src/pages/RemoteDocumentPage.tsx
git commit -m "feat: add document toolbar and export"
```

## Task 4: Lifecycle E2E

**Files:**
- Create: `apps/web/tests/document-lifecycle.spec.ts`

- [ ] **Step 1: Add lifecycle tests**

Create `apps/web/tests/document-lifecycle.spec.ts` with tests that:

1. open `/`;
2. create a blank document;
3. assert navigation to `/docs/:docId/branches/:branchId`;
4. open `/` again;
5. import a Markdown fixture file;
6. assert imported text renders in the editor;
7. click Export Markdown;
8. assert the downloaded filename includes `__EXPORT__`, branch slug, version number, and hash prefix.

Use Playwright's download API:

```ts
const downloadPromise = page.waitForEvent('download');
await page.getByRole('button', { name: 'Export Markdown' }).click();
const download = await downloadPromise;
expect(download.suggestedFilename()).toContain('__EXPORT__');
```

- [ ] **Step 2: Run browser tests**

Run:

```bash
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/marklab_test npx -y pnpm@10.0.0 --filter @marklab/web test:e2e
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/tests/document-lifecycle.spec.ts
git commit -m "test: verify web document lifecycle"
```

## Deployment Gate After This Plan

Before Plan 6.5 starts, these checks must be true:

```text
The root route exposes New Markdown Doc, Import Markdown, and Open document flows.
Create and import navigate to real remote document URLs.
Export downloads the server-produced Markdown with the server-produced versioned filename.
Export mismatch and API errors are visible to the user.
Existing local harness tests remain reachable and passing.
```
