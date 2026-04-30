# Milkdown Transformer, Live Writer, and Export Consistency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fail-closed Milkdown transformer and unavailable live writer seams with a real Milkdown/Yjs-backed implementation, and make export/read/save boundaries select or create a matching immutable version before returning versioned Markdown.

**Architecture:** Add one headless Milkdown runtime in the API package that owns Markdown -> ProseMirror -> Yjs and Yjs -> ProseMirror -> Markdown conversion with the same schema used by the web editor. Use that runtime from import, branch-from-version, human mirror flush, and AI write/edit. Persist the encoded Yjs state, canonical mirror, and version snapshot transactionally; no mirror-only write path is allowed.

**Tech Stack:** TypeScript, Express, Postgres, Milkdown/Crepe, ProseMirror, Yjs, y-prosemirror, jsdom, Vitest, Supertest, Playwright.

---

## Why This Plan Exists Here

Plans 4, 5, and 6 intentionally created safe seams:

```text
milkdown_transformer_not_configured
live_writer_not_configured
invalid_live_yjs_state
export_version_mismatch
```

Those fail-closed states are correct while wiring the backend contract, but the CLI/agent workflow in Plan 7 cannot be useful until successful import, export, read, write, and edit operate against real Yjs/ProseMirror state. Therefore this plan sits between Plan 6 and Plan 7 as `06.2`.

## File Structure

- Create: `apps/api/src/services/milkdown-headless-runtime.ts` — one API-side Milkdown runtime for parse, serialize, Yjs initialization, and changed-range transactions.
- Modify: `apps/api/src/services/milkdown-transformer.ts` — replace the fail-closed transformer with runtime-backed import/branch initialization and mirror flush.
- Test: `apps/api/src/services/milkdown-transformer.real.test.ts`.
- Create: `apps/api/src/services/postgres-live-writer.ts` — concrete `LiveMarkdownWriter` implementation that reads branch Yjs state, applies changed-range transactions, and returns serialized Markdown plus encoded Yjs state.
- Test: `apps/api/src/services/postgres-live-writer.test.ts`.
- Modify: `apps/api/src/routes/doc-ai-routes.ts` — flush the live mirror before `read_doc`, and keep `write_doc`/`edit_doc` on the concrete live writer.
- Modify: `apps/api/src/routes/import-export-routes.ts` — use flush result that creates/selects a matching version before export.
- Modify: `apps/api/src/index.ts` — wire the concrete live writer instead of `createUnavailableLiveMarkdownWriter()`.
- Test: `apps/api/src/routes/doc-ai-routes.e2e.test.ts`.
- Test: `apps/api/src/routes/import-export-routes.export.test.ts`.
- Test: `apps/web/tests/milkdown-collab.spec.ts`.

## Scope Check

This plan does not add CLI commands, auth/token management, branch UI, or deployment infrastructure. It unblocks those later plans by making the API semantically real instead of fail-closed.

This plan must not introduce:

```text
mirror-only AI writes
whole-document live replacement as the intended write path
server-side AI preview/change-set workflow
public multi_edit_doc
local snapshot proposal workflow
```

## Contract Decisions

### Live Writer Return Contract

Every successful `LiveMarkdownWriter.applyMarkdownTransaction()` returns:

```ts
{
  serializedMarkdown: string;
  yjsState: Uint8Array;
  changedRangeCount: number;
  appliedTransactionCount: number;
}
```

`yjsState` must be a valid, non-empty encoded Yjs update. `applyMarkdownToBranchState()` persists this state in the same transaction as `current_markdown`, `current_hash`, and the immutable agent version.

### Export Version Consistency

Exported filenames include a version number and hash. Export must not produce a filename whose version number comes from a head version while the body/hash comes from newer unversioned mirror state.

`flushBranchMarkdownMirror` must therefore either:

1. serialize the live Yjs/ProseMirror state and find that the canonical hash matches the branch head version hash, or
2. create a system `manual_save` version from the flushed canonical mirror and make that version the branch head before export returns.

If the flush cannot serialize live state, export still fails closed. `export_version_mismatch` remains an error for impossible or externally corrupted DB state, not the normal dirty-human-edit path.

### Agent Read Boundary

`read_doc` is an agent boundary. It must flush the live Milkdown/Yjs state to the canonical mirror before returning Markdown. If the flushed hash differs from the head version hash, it must create a system `autosave` version so the returned `versionId` and `hash` are a valid pair for a later guarded `write_doc`.

### Full Write Freshness Boundary

`write_doc` must compare the submitted `baseHash` with the Markdown hash serialized from live Yjs before the agent transaction is applied. If those hashes differ, reject with a retryable conflict and require the agent to call `read_doc` again. Pre-agent checkpoint creation must not turn a stale full-document write into an accepted overwrite of newer human live edits.

## Task 1: Add API Milkdown Runtime Dependencies

**Files:**
- Modify: `apps/api/package.json`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Install runtime dependencies**

Run:

```bash
npx -y pnpm@10.0.0 --filter @marklab/api add @milkdown/crepe@^7.20.0 @milkdown/kit@^7.20.0 @milkdown/plugin-collab@^7.20.0 jsdom@^25.0.0 y-prosemirror@^1.2.15
npx -y pnpm@10.0.0 --filter @marklab/api add -D @types/jsdom@^21.1.7
```

Expected: `apps/api/package.json` contains the Milkdown runtime dependencies directly. Do not rely on `apps/web` dependencies or transitive peer dependencies.

- [ ] **Step 2: Run API typecheck**

Run:

```bash
npx -y pnpm@10.0.0 --filter @marklab/api typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/api/package.json pnpm-lock.yaml
git commit -m "chore: add api milkdown runtime dependencies"
```

## Task 2: Headless Milkdown Runtime Tests

**Files:**
- Create: `apps/api/src/services/milkdown-headless-runtime.ts`
- Test: `apps/api/src/services/milkdown-headless-runtime.test.ts`

- [ ] **Step 1: Write runtime tests**

Create `apps/api/src/services/milkdown-headless-runtime.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createHeadlessMilkdownRuntime } from './milkdown-headless-runtime';

describe('createHeadlessMilkdownRuntime', () => {
  it('initializes valid non-empty Yjs state from Markdown and serializes canonical Markdown', async () => {
    const runtime = createHeadlessMilkdownRuntime();
    const result = await runtime.initializeFromMarkdown('# Imported\n\n| A | B |\n| - | - |\n| 1 | 2 |\n');

    expect(result.yjsState.byteLength).toBeGreaterThan(0);
    expect(result.markdown).toContain('# Imported');
    expect(result.markdown).toContain('| A');
    expect(result.hash).toMatch(/^sha256:/u);

    const doc = new Y.Doc();
    Y.applyUpdate(doc, result.yjsState);
    expect(doc.getXmlFragment('prosemirror').length).toBeGreaterThan(0);
    doc.destroy();
  });

  it('serializes existing Yjs state through Milkdown before canonical formatting', async () => {
    const runtime = createHeadlessMilkdownRuntime();
    const initialized = await runtime.initializeFromMarkdown('## Live doc\n\nParagraph\n');
    const serialized = await runtime.serializeYjsState(initialized.yjsState);

    expect(serialized.markdown).toBe(initialized.markdown);
    expect(serialized.hash).toBe(initialized.hash);
    expect(serialized.yjsState.byteLength).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npx -y pnpm@10.0.0 test apps/api/src/services/milkdown-headless-runtime.test.ts
```

Expected: FAIL with module not found for `./milkdown-headless-runtime`.

## Task 3: Implement Headless Milkdown Runtime

**Files:**
- Create: `apps/api/src/services/milkdown-headless-runtime.ts`

- [ ] **Step 1: Implement runtime**

Create `apps/api/src/services/milkdown-headless-runtime.ts`:

```ts
import { canonicalizeMarkdown } from '@marklab/markdown/src/canonicalize';
import { sha256Hex } from '@marklab/shared/src/hash';
import { Editor, editorViewCtx, rootCtx } from '@milkdown/kit/core';
import { commonmark } from '@milkdown/kit/preset/commonmark';
import { gfm } from '@milkdown/kit/preset/gfm';
import { collab, collabServiceCtx } from '@milkdown/plugin-collab';
import { getMarkdown } from '@milkdown/kit/utils';
import { JSDOM } from 'jsdom';
import * as Y from 'yjs';

export interface RuntimeMarkdownState {
  yjsState: Uint8Array;
  markdown: string;
  hash: string;
}

interface RuntimeSession {
  editor: Editor;
  ydoc: Y.Doc;
  cleanup(): void;
}

function installDom(dom: JSDOM) {
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
  };

  Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true });
  Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true });
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });

  return () => {
    Object.defineProperty(globalThis, 'window', { value: previous.window, configurable: true });
    Object.defineProperty(globalThis, 'document', { value: previous.document, configurable: true });
    Object.defineProperty(globalThis, 'navigator', { value: previous.navigator, configurable: true });
  };
}

async function createSession(input: { yjsState?: Uint8Array; seedMarkdown?: string }): Promise<RuntimeSession> {
  const dom = new JSDOM('<!doctype html><html><body><div id="editor"></div></body></html>');
  const restoreDom = installDom(dom);
  const root = dom.window.document.querySelector('#editor');
  if (!(root instanceof dom.window.HTMLElement)) throw new Error('headless_root_not_found');

  const ydoc = new Y.Doc();
  if (input.yjsState && input.yjsState.byteLength > 0) {
    Y.applyUpdate(ydoc, input.yjsState);
  }

  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root as unknown as HTMLElement);
    })
    .use(commonmark)
    .use(gfm)
    .use(collab)
    .create();

  editor.action((ctx) => {
    ctx.get(collabServiceCtx)
      .bindDoc(ydoc)
      .applyTemplate(input.seedMarkdown ?? '')
      .connect();
  });

  return {
    editor,
    ydoc,
    cleanup() {
      editor.destroy();
      ydoc.destroy();
      dom.window.close();
      restoreDom();
    },
  };
}

async function serializeSession(session: RuntimeSession): Promise<RuntimeMarkdownState> {
  const serializedMarkdown = session.editor.action(getMarkdown());
  const markdown = await canonicalizeMarkdown(serializedMarkdown);
  return {
    yjsState: Y.encodeStateAsUpdate(session.ydoc),
    markdown,
    hash: sha256Hex(markdown),
  };
}

export interface HeadlessMilkdownRuntime {
  initializeFromMarkdown(markdown: string): Promise<RuntimeMarkdownState>;
  serializeYjsState(yjsState: Uint8Array): Promise<RuntimeMarkdownState>;
}

export function createHeadlessMilkdownRuntime(): HeadlessMilkdownRuntime {
  return {
    async initializeFromMarkdown(markdown) {
      const session = await createSession({ seedMarkdown: markdown });
      try {
        return await serializeSession(session);
      } finally {
        session.cleanup();
      }
    },

    async serializeYjsState(yjsState) {
      if (yjsState.byteLength === 0) throw new Error('invalid_yjs_state');
      const session = await createSession({ yjsState });
      try {
        return await serializeSession(session);
      } finally {
        session.cleanup();
      }
    },
  };
}
```

- [ ] **Step 2: Run runtime test**

Run:

```bash
npx -y pnpm@10.0.0 test apps/api/src/services/milkdown-headless-runtime.test.ts
```

Expected: PASS. If Milkdown requires additional DOM globals under jsdom, add them inside `installDom` and keep the test as the API lock.

- [ ] **Step 3: Run API typecheck**

Run:

```bash
npx -y pnpm@10.0.0 --filter @marklab/api typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/milkdown-headless-runtime.ts apps/api/src/services/milkdown-headless-runtime.test.ts
git commit -m "feat: add headless milkdown runtime"
```

## Task 4: Replace Transformer Seam With Runtime

**Files:**
- Modify: `apps/api/src/services/milkdown-transformer.ts`
- Test: `apps/api/src/services/milkdown-transformer.real.test.ts`

- [ ] **Step 1: Write transformer tests**

Create `apps/api/src/services/milkdown-transformer.real.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { initializeBranchEditorState } from './milkdown-transformer';

describe('runtime-backed milkdown transformer', () => {
  it('initializes imported markdown as live Yjs state and canonical markdown', async () => {
    const result = await initializeBranchEditorState('# Imported\n\n- [ ] Task\n\n```mermaid\ngraph TD\n  A-->B\n```\n');

    expect(result.markdown).toContain('# Imported');
    expect(result.markdown).toContain('```mermaid');
    expect(result.hash).toMatch(/^sha256:/u);
    expect(result.yjsState.byteLength).toBeGreaterThan(0);

    const doc = new Y.Doc();
    Y.applyUpdate(doc, result.yjsState);
    expect(doc.getXmlFragment('prosemirror').length).toBeGreaterThan(0);
    doc.destroy();
  });
});
```

Add a second test in the same file for `flushBranchMarkdownMirror`. Seed a fake pool with a non-empty `yjs_state` produced by `createHeadlessMilkdownRuntime().initializeFromMarkdown('# Dirty live\n')`, set the branch head version hash to a different value, and assert:

```ts
expect(result).toMatchObject({
  branchId: 'br_main',
  hash: seeded.hash,
  versionId: 'ver_002',
  versionNumber: 2,
  createdVersion: true,
});
expect(versionInsert?.params).toEqual([
  'doc_001',
  'br_main',
  'ver_001',
  2,
  seeded.markdown,
  seeded.hash,
  'system',
  null,
  'manual_save',
]);
```

This test is the lock that normal dirty live state becomes a matching immutable version instead of surfacing `export_version_mismatch`.

- [ ] **Step 2: Replace the seam**

Modify `apps/api/src/services/milkdown-transformer.ts`:

```ts
import type { DbPool } from '../db/client';
import { withTransaction } from '../db/client';
import { createVersionWithClient } from './version-service';
import { createHeadlessMilkdownRuntime } from './milkdown-headless-runtime';

export interface InitializedBranchEditorState {
  yjsState: Uint8Array;
  markdown: string;
  hash: string;
}

export interface FlushBranchMarkdownMirrorResult {
  branchId: string;
  markdown: string;
  hash: string;
  versionId: string;
  versionNumber: number;
  createdVersion: boolean;
}

export type FlushVersionOperation = 'autosave' | 'manual_save';

const runtime = createHeadlessMilkdownRuntime();

export async function initializeBranchEditorState(markdown: string): Promise<InitializedBranchEditorState> {
  return runtime.initializeFromMarkdown(markdown);
}

export async function flushBranchMarkdownMirror(
  pool: DbPool,
  docId: string,
  branchId: string,
  operation: FlushVersionOperation = 'autosave',
): Promise<FlushBranchMarkdownMirrorResult> {
  return withTransaction(pool, async (client) => {
    const state = await client.query<{
      yjs_state: Buffer;
      head_version_id: string;
      head_version_number: number;
      head_hash: string;
    }>(
      `select s.yjs_state,
              b.head_version_id,
              v.version_number as head_version_number,
              v.hash as head_hash
         from document_branches b
         join document_branch_states s on s.branch_id = b.id
         join document_versions v on v.id = b.head_version_id
        where b.doc_id = $1 and b.id = $2 and b.is_archived = false
        for update of b, s`,
      [docId, branchId],
    );
    const row = state.rows[0];
    if (!row) throw new Error('branch_not_found');

    const serialized = await runtime.serializeYjsState(new Uint8Array(row.yjs_state));

    await client.query(
      `update document_branch_states
          set yjs_state = $3,
              current_markdown = $4,
              current_hash = $5,
              updated_at = now()
        where branch_id = $1 and exists (select 1 from document_branches where id = $1 and doc_id = $2 and is_archived = false)`,
      [branchId, docId, Buffer.from(serialized.yjsState), serialized.markdown, serialized.hash],
    );

    if (serialized.hash === row.head_hash) {
      return {
        branchId,
        markdown: serialized.markdown,
        hash: serialized.hash,
        versionId: row.head_version_id,
        versionNumber: row.head_version_number,
        createdVersion: false,
      };
    }

    const version = await createVersionWithClient({
      client,
      docId,
      branchId,
      parentVersionId: row.head_version_id,
      markdown: serialized.markdown,
      hash: serialized.hash,
      actorType: 'system',
      operation,
    });

    return {
      branchId,
      markdown: serialized.markdown,
      hash: serialized.hash,
      versionId: version.versionId,
      versionNumber: version.versionNumber,
      createdVersion: true,
    };
  });
}
```

- [ ] **Step 3: Run transformer tests**

Run:

```bash
npx -y pnpm@10.0.0 test apps/api/src/services/milkdown-transformer.real.test.ts apps/api/src/services/milkdown-transformer.test.ts
```

Expected: update or remove the old fail-closed assertions after the real transformer is wired. The runtime-backed tests must pass.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/milkdown-transformer.ts apps/api/src/services/milkdown-transformer.real.test.ts apps/api/src/services/milkdown-transformer.test.ts
git commit -m "feat: wire milkdown transformer runtime"
```

## Task 5: Concrete Postgres Live Writer Tests

**Files:**
- Create: `apps/api/src/services/postgres-live-writer.ts`
- Test: `apps/api/src/services/postgres-live-writer.test.ts`

- [ ] **Step 1: Write live writer tests**

Create `apps/api/src/services/postgres-live-writer.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { DbPool, DbQueryResult } from '../db/client';
import { createHeadlessMilkdownRuntime } from './milkdown-headless-runtime';
import { createPostgresLiveMarkdownWriter } from './postgres-live-writer';

function createPoolWithBranchState(input: { yjsState: Uint8Array; markdown: string; hash: string }) {
  const queries: { sql: string; params?: readonly unknown[] }[] = [];
  const pool: DbPool = {
    async query<Row = unknown>(sql: string, params?: readonly unknown[]): Promise<DbQueryResult<Row>> {
      queries.push(params ? { sql, params } : { sql });
      if (sql.includes('from document_branch_states')) {
        return {
          rows: [
            {
              yjs_state: Buffer.from(input.yjsState),
              current_markdown: input.markdown,
              current_hash: input.hash,
            } as Row,
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
    async connect() {
      throw new Error('connect_not_used_by_writer');
    },
  };
  return { pool, queries };
}

describe('createPostgresLiveMarkdownWriter', () => {
  const runtime = createHeadlessMilkdownRuntime();

  it('applies target markdown through live Yjs state and returns non-empty encoded state', async () => {
    const seeded = await runtime.initializeFromMarkdown('# Original\n\nKeep\n');
    const { pool } = createPoolWithBranchState(seeded);
    const writer = createPostgresLiveMarkdownWriter(pool);

    const applied = await writer.applyMarkdownTransaction({
      branchId: 'br_main',
      targetCanonicalMarkdown: '# Original\n\nChanged\n',
      operation: { kind: 'write', baseVersionId: 'ver_001', baseHash: seeded.hash },
    });

    expect(applied.serializedMarkdown).toContain('Changed');
    expect(applied.yjsState.byteLength).toBeGreaterThan(0);
    expect(applied.changedRangeCount).toBeGreaterThan(0);
    expect(applied.appliedTransactionCount).toBeGreaterThan(0);
  });

  it('seeds an empty live document from current_markdown before applying target markdown', async () => {
    const blank = await runtime.initializeFromMarkdown('');
    const { pool } = createPoolWithBranchState({
      yjsState: blank.yjsState,
      markdown: '# Imported before browser open\n\nOld\n',
      hash: blank.hash,
    });
    const writer = createPostgresLiveMarkdownWriter(pool);

    const applied = await writer.applyMarkdownTransaction({
      branchId: 'br_imported',
      targetCanonicalMarkdown: '# Imported before browser open\n\nNew\n',
      operation: { kind: 'edit', oldString: 'Old', newString: 'New', replaceAll: false },
    });

    expect(applied.serializedMarkdown).toContain('Imported before browser open');
    expect(applied.serializedMarkdown).toContain('New');
    expect(applied.yjsState.byteLength).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npx -y pnpm@10.0.0 test apps/api/src/services/postgres-live-writer.test.ts
```

Expected: FAIL with module not found for `./postgres-live-writer`.

## Task 6: Implement Concrete Postgres Live Writer

**Files:**
- Create: `apps/api/src/services/postgres-live-writer.ts`

- [ ] **Step 1: Implement writer**

Create `apps/api/src/services/postgres-live-writer.ts`:

```ts
import type { DbPool } from '../db/client';
import type { AppliedLiveMarkdownTransaction, LiveMarkdownTransaction, LiveMarkdownWriter } from './live-writer';
import { createHeadlessMilkdownRuntime } from './milkdown-headless-runtime';

export function createPostgresLiveMarkdownWriter(pool: DbPool): LiveMarkdownWriter {
  const runtime = createHeadlessMilkdownRuntime();

  return {
    async applyMarkdownTransaction(transaction: LiveMarkdownTransaction): Promise<AppliedLiveMarkdownTransaction> {
      const state = await pool.query<{ yjs_state: Buffer; current_markdown: string; current_hash: string }>(
        `select yjs_state, current_markdown, current_hash
           from document_branch_states
          where branch_id = $1`,
        [transaction.branchId],
      );
      const row = state.rows[0];
      if (!row) throw new Error('branch_not_found');

      return runtime.applyChangedRanges({
        branchId: transaction.branchId,
        yjsState: new Uint8Array(row.yjs_state),
        seedMarkdown: row.current_markdown,
        targetCanonicalMarkdown: transaction.targetCanonicalMarkdown,
      });
    },
  };
}
```

Extend `apps/api/src/services/milkdown-headless-runtime.ts` with:

```ts
export interface ApplyChangedRangesInput {
  branchId: string;
  yjsState: Uint8Array;
  seedMarkdown: string;
  targetCanonicalMarkdown: string;
}
```

and add `applyChangedRanges(input)` to `HeadlessMilkdownRuntime`. It must:

1. create a Yjs-bound Milkdown session from `input.yjsState`;
2. call `collabService.applyTemplate(input.seedMarkdown)` before diffing so unopened imported/branched docs seed from `current_markdown`;
3. parse `input.targetCanonicalMarkdown` through Milkdown parser;
4. compute changed ranges using ProseMirror document content comparison;
5. dispatch transactions for only changed ranges, from document end to start;
6. serialize the resulting live doc back to Markdown;
7. return non-empty `Y.encodeStateAsUpdate(ydoc)`.

Use ProseMirror content diff helpers for the first implementation:

```ts
const start = currentDoc.content.findDiffStart(targetDoc.content);
const end = currentDoc.content.findDiffEnd(targetDoc.content);
if (start === null || !end) {
  return {
    serializedMarkdown: await canonicalizeMarkdown(session.editor.action(getMarkdown())),
    yjsState: Y.encodeStateAsUpdate(session.ydoc),
    changedRangeCount: 0,
    appliedTransactionCount: 0,
  };
}

const tr = view.state.tr.replace(
  start,
  end.a,
  targetDoc.slice(start, end.b, true),
);
view.dispatch(tr);
```

This is a changed-range transaction, not a mirror-only write. If this first implementation ever computes a full-document range for non-empty current and target docs, keep it visible through `changedRangeCount` and add a follow-up block-level diff task before marking the MVP live writer polished.

- [ ] **Step 2: Run live writer tests**

Run:

```bash
npx -y pnpm@10.0.0 test apps/api/src/services/postgres-live-writer.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run API typecheck**

Run:

```bash
npx -y pnpm@10.0.0 --filter @marklab/api typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/postgres-live-writer.ts apps/api/src/services/postgres-live-writer.test.ts apps/api/src/services/milkdown-headless-runtime.ts apps/api/src/services/milkdown-headless-runtime.test.ts
git commit -m "feat: add postgres-backed live markdown writer"
```

## Task 7: Flush Before Agent Read and Export

**Files:**
- Modify: `apps/api/src/routes/doc-ai-routes.ts`
- Modify: `apps/api/src/routes/import-export-routes.ts`
- Test: `apps/api/src/routes/doc-ai-routes.e2e.test.ts`
- Test: `apps/api/src/routes/import-export-routes.export.test.ts`

- [ ] **Step 1: Add read flush test**

Update the existing `createFakePool` in `apps/api/src/routes/doc-ai-routes.e2e.test.ts` instead of adding a second ad hoc fake DB helper:

1. add `yjsState?: Uint8Array` to `FakePoolOptions`;
2. make the branch-state query row include `yjs_state`, `head_version_number`, and `head_hash` for `flushBranchMarkdownMirror`;
3. make the `insert into document_versions` and branch-head update paths mutate the fake `currentVersionId`, `currentVersionNumber`, `currentHash`, and `headHash` variables, because `read_doc` will read the post-flush state in the same request.

Then add this test:

```ts
it('flushes live state and creates an autosave version before read_doc returns version and hash', async () => {
  const runtime = createHeadlessMilkdownRuntime();
  const seeded = await runtime.initializeFromMarkdown('# Human live edit\n');
  const { pool } = createFakePool({
    currentMarkdown: seeded.markdown,
    currentHash: seeded.hash,
    currentVersionId: 'ver_001',
    currentVersionNumber: 1,
    headHash: 'sha256:old',
    yjsState: seeded.yjsState,
    versionIds: ['ver_002'],
  });
  const app = createHttpApp(pool, createPostgresLiveMarkdownWriter(pool));

  const response = await request(app).get('/api/docs/doc_001/branches/br_main/read').expect(200);

  expect(response.body.versionId).toBe('ver_002');
  expect(response.body.versionNumber).toBe(2);
  expect(response.body.hash).toBe(seeded.hash);
  expect(response.body.markdown).toBe(seeded.markdown);
});
```

- [ ] **Step 2: Modify read route**

In `apps/api/src/routes/doc-ai-routes.ts`, import `flushBranchMarkdownMirror` and flush before reading:

```ts
import { flushBranchMarkdownMirror } from '../services/milkdown-transformer';
```

Then update the read handler:

```ts
await flushBranchMarkdownMirror(pool, docId, branchId, 'autosave');
res.json(await readBranchState(pool, docId, branchId));
```

- [ ] **Step 3: Add export consistency test**

Update `apps/api/src/routes/import-export-routes.export.test.ts` so the route accepts the version metadata returned by `flushBranchMarkdownMirror` and still rejects impossible post-flush mismatch. This route test can keep mocking the transformer; the real dirty-live-state serialization and version creation are covered by `milkdown-transformer.real.test.ts`.

Change the mocked transformer to return the selected or newly created version:

```ts
vi.mocked(flushBranchMarkdownMirror).mockResolvedValue({
  branchId: 'br_main',
  markdown: '# Exported\n',
  hash: 'sha256:fresh',
  versionId: 'ver_011',
  versionNumber: 11,
  createdVersion: true,
});
```

Then extend `createExportPool` so the metadata query can return `version_id: 'ver_011'`, `version_number: 11`, and `version_hash: 'sha256:fresh'`, and add:

```ts
it('exports with the flushed version metadata when flush creates a matching manual_save version', async () => {
  const { pool } = createExportPool({ currentHash: 'sha256:fresh', versionHash: 'sha256:fresh', versionNumber: 11 });
  const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter());

  const response = await request(app).get('/api/docs/doc_001/branches/br_main/export.md').expect(200);

  expect(response.text).toBe('# Exported\n');
  expect(response.headers['content-disposition']).toContain('__v0011__');
  expect(response.headers['content-disposition']).toContain('__sha-fresh__');
});
```

- [ ] **Step 4: Modify export route**

In `apps/api/src/routes/import-export-routes.ts`, use the flush result as the source of export version metadata:

```ts
const flushed = await flushBranchMarkdownMirror(pool, docId, branchId, 'manual_save');
const state = await readBranchState(pool, docId, branchId);
if (state.versionId !== flushed.versionId || state.hash !== flushed.hash) {
  throw new ExportVersionMismatchError(state.hash, flushed.hash);
}
```

Keep the existing mismatch response for corrupted or externally inconsistent data.

- [ ] **Step 5: Run route tests**

Run:

```bash
npx -y pnpm@10.0.0 test apps/api/src/routes/doc-ai-routes.e2e.test.ts apps/api/src/routes/import-export-routes.export.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/doc-ai-routes.ts apps/api/src/routes/doc-ai-routes.e2e.test.ts apps/api/src/routes/import-export-routes.ts apps/api/src/routes/import-export-routes.export.test.ts
git commit -m "feat: flush live markdown before read and export"
```

## Task 8: Wire Concrete Writer Into API Entrypoint

**Files:**
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/src/http/app.ts`
- Test: `apps/api/src/routes/doc-ai-routes.test.ts`

- [ ] **Step 1: Update entrypoint**

Modify `apps/api/src/index.ts`:

```ts
import { createPostgresLiveMarkdownWriter } from './services/postgres-live-writer';
```

Replace:

```ts
const liveWriter = createUnavailableLiveMarkdownWriter();
```

with:

```ts
const liveWriter = createPostgresLiveMarkdownWriter(pool);
```

- [ ] **Step 2: Keep fail-closed tests for injected unavailable writer**

Do not delete tests that pass `createUnavailableLiveMarkdownWriter()` directly to `createHttpApp`. They prove the app still fails closed when a test or future deployment explicitly injects no writer.

- [ ] **Step 3: Run API tests and typecheck**

Run:

```bash
npx -y pnpm@10.0.0 test apps/api/src
npx -y pnpm@10.0.0 --filter @marklab/api typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/index.ts apps/api/src/http/app.ts apps/api/src/routes/doc-ai-routes.test.ts
git commit -m "feat: wire concrete live markdown writer"
```

## Task 9: Browser Smoke Test for API-Originated Writes

> **Context note:** This smoke test requires a real Web remote document route and a backend-backed browser fixture. That product entry point is now split into `plans/06_3_web_remote_document_mode_plan.md`. If Plan 6.2 implementation already completed without this test, treat this task as moved to Plan 6.3 rather than as coverage supplied by Plan 7.

**Files:**
- Modify: `apps/web/tests/milkdown-collab.spec.ts`

- [ ] **Step 1: Add browser-visible API write test**

Add a Playwright test that:

1. starts the API and web app;
2. opens one collaborative editor;
3. creates/imports a doc through the API;
4. opens that doc branch in the editor;
5. calls `write_doc` against the API;
6. verifies the editor view updates without refresh.

Use the existing web test server pattern from `apps/web/playwright.config.ts` and avoid hard-coded sleeps. Wait for visible editor text.

- [ ] **Step 2: Run browser tests**

Run:

```bash
npx -y pnpm@10.0.0 --filter @marklab/web test:e2e
```

Expected: PASS. If the local DB/API setup is not available in Playwright yet, add the missing test fixture in this task rather than skipping the test.

- [ ] **Step 3: Commit**

```bash
git add apps/web/tests/milkdown-collab.spec.ts apps/web/playwright.config.ts
git commit -m "test: verify api writes update live editor"
```

## Task 10: Final Verification

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

- [ ] **Step 3: Verify removed workflows remain absent**

Run:

```bash
rg -n "multi_edit_doc|multi-edit|snapshot create|proposal\\.md|submit-snapshot|preview_doc_change|apply_doc_change|change_sets" apps packages skills plans
```

Expected: matches only appear in tests or docs that explicitly forbid these workflows.

- [ ] **Step 4: Commit any final test/doc fixes**

```bash
git status --short
git add apps/api/src apps/web/tests apps/api/package.json pnpm-lock.yaml
git commit -m "test: verify live markdown integration"
```

Skip this commit if `git status --short` is clean after the earlier task commits.

## Deployment Gate After This Plan

Before Plan 7 starts, these checks must be true:

```text
POST /api/docs succeeds for blank docs.
POST /api/docs/import succeeds for supported fixtures.
GET /api/docs/:docId/branches/:branchId/read returns freshly flushed canonical Markdown.
POST /api/docs/:docId/branches/:branchId/write succeeds with baseVersionId + baseHash and updates yjs_state.
POST /api/docs/:docId/branches/:branchId/edit succeeds with oldString/newString and updates yjs_state.
GET /api/docs/:docId/branches/:branchId/export.md returns a filename whose version/hash match the exported body.
No successful path writes current_markdown/current_hash without also writing valid encoded yjs_state first or in the same transaction.
```
