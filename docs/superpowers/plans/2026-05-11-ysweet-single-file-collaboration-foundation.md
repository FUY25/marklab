# Y-Sweet Single-File Collaboration Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first safe implementation slice for MarkLab's Relay/Y-Sweet-style single-file collaboration model without allowing stale disk state, public view links, or client-writable identity metadata to become write or audit authority.

**Architecture:** Keep the local `.md` file as the user-owned artifact and `Y.Text("contents")` as the live merge surface. Add a persisted `lastProjectedMarkdown` baseline for disk/provider reconciliation, issue Y-Sweet native `ClientToken`s only for edit-capable sessions, and keep public view links on a control-plane current-state snapshot path with no provider credentials.

**Tech Stack:** TypeScript, Vitest, Express 5, PostgreSQL schema SQL, Yjs, Y-Sweet SDK `@y-sweet/sdk@0.9.1`, existing MarkLab `LocalFileService`, existing MarkLab access-control route patterns.

---

## Scope Check

This plan intentionally implements the Phase 1A safety spine only:

- Baseline-aware local file/provider reconciliation.
- Metadata persistence for `lastProjectedMarkdown`, `lastProjectedHash`, and provider fingerprint.
- Y-Sweet token adapter using native `ClientToken` semantics.
- API contract that gives edit sessions a short-lived provider token and gives view sessions a current Markdown snapshot without provider credentials.
- Tests proving the dangerous cases from the Relay/Y-Sweet review.

The browser collaborator app (`apps/collab-web`), native MarkLab.app UI, account/team/billing UI, folder permissions, and trusted live read-only provider sessions need separate plans after this slice lands.

## File Structure

- Create `packages/shared/src/markdown-reconciliation.ts`
  - Pure decision helper for baseline/disk/provider comparison.
  - Owns CRLF-to-LF normalization at the collaboration boundary.
- Create `packages/shared/src/markdown-reconciliation.test.ts`
  - Unit tests for one-sided disk changes, one-sided provider changes, converged changes, and both-sides-changed conflicts.
- Modify `packages/shared/src/index.ts`
  - Export the reconciliation helper.
- Modify `apps/api/src/local/local-metadata-store.ts`
  - Persist optional projection baseline fields while keeping `schemaVersion: 1` backward-compatible.
- Modify `apps/api/src/local/local-metadata-store.test.ts`
  - Prove baseline metadata is stored and old metadata remains readable.
- Modify `apps/api/src/local/local-file-service.ts`
  - Load baseline metadata.
  - Update baseline only after a successful provider-to-disk projection or disk-to-provider ingestion.
  - Use the shared helper inside `applySerializedRoomState` and `applyExternalDiskMarkdown`.
- Modify `apps/api/src/local/local-file-service.test.ts`
  - Add regression tests for stale disk not overwriting remote provider edits, stale provider not overwriting disk edits, and both-sides-changed conflict pause.
- Modify `apps/api/package.json` and `pnpm-lock.yaml`
  - Add `@y-sweet/sdk@0.9.1`.
- Create `apps/api/src/provider/ysweet-token-service.ts`
  - Small adapter around Y-Sweet `DocumentManager.getOrCreateDocAndToken`.
  - Enforces default 10-minute TTL and records MarkLab session metadata in the return value.
- Create `apps/api/src/provider/ysweet-token-service.test.ts`
  - Unit tests with a fake manager proving `authorization` and `validForSeconds` are passed exactly.
- Create `apps/api/src/services/provider-doc-service.ts`
  - Ensures each branch has an opaque provider document id.
- Create `apps/api/src/services/provider-doc-service.test.ts`
  - Tests existing id reuse and new opaque id generation.
- Modify `apps/api/src/db/schema.sql`
  - Add `document_branch_states.provider_doc_id`.
  - Add `provider_token_issuances` for server-side token issuance/audit metadata.
- Create `apps/api/src/routes/collab-session-routes.ts`
  - Adds `POST /api/docs/:docId/branches/:branchId/collab/session`.
  - Adds `POST /api/docs/:docId/branches/:branchId/collab/session/:sessionId/provider-token/refresh`.
  - `mode: "edit"` returns a Y-Sweet provider token after write access check.
  - `mode: "view"` returns current Markdown snapshot after read access check and never returns a provider token.
- Create `apps/api/src/routes/collab-session-routes.test.ts`
  - Tests edit token, edit token refresh, view snapshot, and revoked/no-write behavior through injected fakes.
- Modify `apps/api/src/http/app.ts`
  - Add optional `providerTokenService` to `HttpAppOptions`.
  - Mount collab session routes in hosted mode.

## Implementation Tasks

### Task 1: Shared Markdown Reconciliation Helper

**Files:**
- Create: `packages/shared/src/markdown-reconciliation.ts`
- Create: `packages/shared/src/markdown-reconciliation.test.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Write the failing reconciliation tests**

Create `packages/shared/src/markdown-reconciliation.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { decideMarkdownReconciliation, normalizeCollabMarkdown } from './markdown-reconciliation';

describe('markdown reconciliation', () => {
  it('normalizes CRLF and CR at the collaboration boundary', () => {
    expect(normalizeCollabMarkdown('a\r\nb\rc\n')).toBe('a\nb\nc\n');
  });

  it('projects provider content when only provider changed from the baseline', () => {
    expect(decideMarkdownReconciliation({
      lastProjectedMarkdown: '# Base\n',
      diskMarkdown: '# Base\n',
      providerMarkdown: '# Remote\n',
    })).toEqual({
      kind: 'project_provider_to_disk',
      markdown: '# Remote\n',
    });
  });

  it('ingests disk content when only disk changed from the baseline', () => {
    expect(decideMarkdownReconciliation({
      lastProjectedMarkdown: '# Base\n',
      diskMarkdown: '# Local\n',
      providerMarkdown: '# Base\n',
    })).toEqual({
      kind: 'ingest_disk_to_provider',
      markdown: '# Local\n',
    });
  });

  it('accepts converged content when disk and provider independently changed to the same text', () => {
    expect(decideMarkdownReconciliation({
      lastProjectedMarkdown: '# Base\n',
      diskMarkdown: '# Same\n',
      providerMarkdown: '# Same\n',
    })).toEqual({
      kind: 'accept_converged',
      markdown: '# Same\n',
    });
  });

  it('opens conflict when disk and provider diverged from the same baseline', () => {
    expect(decideMarkdownReconciliation({
      lastProjectedMarkdown: '# Base\n',
      diskMarkdown: '# Local\n',
      providerMarkdown: '# Remote\n',
    })).toEqual({
      kind: 'conflict',
      baseMarkdown: '# Base\n',
      diskMarkdown: '# Local\n',
      providerMarkdown: '# Remote\n',
    });
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run:

```bash
npx -y pnpm@10.0.0 test packages/shared/src/markdown-reconciliation.test.ts
```

Expected: FAIL with `Cannot find module './markdown-reconciliation'`.

- [ ] **Step 3: Implement the helper**

Create `packages/shared/src/markdown-reconciliation.ts`:

```ts
export type MarkdownReconciliationDecision =
  | { kind: 'noop'; markdown: string }
  | { kind: 'accept_converged'; markdown: string }
  | { kind: 'project_provider_to_disk'; markdown: string }
  | { kind: 'ingest_disk_to_provider'; markdown: string }
  | { kind: 'conflict'; baseMarkdown: string; diskMarkdown: string; providerMarkdown: string };

export interface MarkdownReconciliationInput {
  lastProjectedMarkdown: string;
  diskMarkdown: string;
  providerMarkdown: string;
}

export function normalizeCollabMarkdown(markdown: string): string {
  return markdown.replace(/\r\n?/gu, '\n');
}

export function decideMarkdownReconciliation(input: MarkdownReconciliationInput): MarkdownReconciliationDecision {
  const baseMarkdown = normalizeCollabMarkdown(input.lastProjectedMarkdown);
  const diskMarkdown = normalizeCollabMarkdown(input.diskMarkdown);
  const providerMarkdown = normalizeCollabMarkdown(input.providerMarkdown);

  if (diskMarkdown === providerMarkdown) {
    return diskMarkdown === baseMarkdown
      ? { kind: 'noop', markdown: diskMarkdown }
      : { kind: 'accept_converged', markdown: diskMarkdown };
  }

  const diskChanged = diskMarkdown !== baseMarkdown;
  const providerChanged = providerMarkdown !== baseMarkdown;

  if (!diskChanged && providerChanged) {
    return { kind: 'project_provider_to_disk', markdown: providerMarkdown };
  }

  if (diskChanged && !providerChanged) {
    return { kind: 'ingest_disk_to_provider', markdown: diskMarkdown };
  }

  return {
    kind: 'conflict',
    baseMarkdown,
    diskMarkdown,
    providerMarkdown,
  };
}
```

- [ ] **Step 4: Export the helper**

Modify `packages/shared/src/index.ts`:

```ts
export * from './edit-ops';
export * from './export-filename';
export * from './hash';
export * from './markdown-reconciliation';
```

- [ ] **Step 5: Run the shared tests**

Run:

```bash
npx -y pnpm@10.0.0 test packages/shared/src/markdown-reconciliation.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/markdown-reconciliation.ts packages/shared/src/markdown-reconciliation.test.ts packages/shared/src/index.ts
git commit -m "feat: add markdown reconciliation helper"
```

### Task 2: Persist Projection Baseline Metadata

**Files:**
- Modify: `apps/api/src/local/local-metadata-store.ts`
- Modify: `apps/api/src/local/local-metadata-store.test.ts`

- [ ] **Step 1: Write the failing metadata test**

Add this test to `apps/api/src/local/local-metadata-store.test.ts`:

```ts
  it('persists local projection baseline metadata for reconnect reconciliation', async () => {
    const metadataPath = await createMetadataPath();
    const store = createJsonLocalMetadataStore(metadataPath);

    await store.saveDocument({
      schemaVersion: 1,
      localDocId: 'doc_local',
      absolutePath: '/tmp/local.md',
      displayName: 'local.md',
      roomName: 'local:file:doc_local',
      lastDiskHash: 'sha256:disk',
      currentHash: 'sha256:current',
      currentYjsStateBase64: Buffer.from([1, 2, 3]).toString('base64'),
      lastProjectedMarkdown: '# Projected\n',
      lastProjectedHash: 'sha256:projected',
      lastProviderStateFingerprint: 'fp_projected',
      updatedAt: '2026-05-11T00:00:00.000Z',
    });

    const reloaded = createJsonLocalMetadataStore(metadataPath);
    await expect(reloaded.loadDocument('/tmp/local.md')).resolves.toMatchObject({
      lastProjectedMarkdown: '# Projected\n',
      lastProjectedHash: 'sha256:projected',
      lastProviderStateFingerprint: 'fp_projected',
    });
  });
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
npx -y pnpm@10.0.0 test apps/api/src/local/local-metadata-store.test.ts
```

Expected: FAIL with TypeScript excess-property errors for `lastProjectedMarkdown`, `lastProjectedHash`, and `lastProviderStateFingerprint`.

- [ ] **Step 3: Add backward-compatible fields**

Modify `StoredLocalDocument` in `apps/api/src/local/local-metadata-store.ts`:

```ts
export interface StoredLocalDocument {
  schemaVersion: 1;
  localDocId: string;
  absolutePath: string;
  displayName: string;
  roomName: string;
  lastDiskHash: string;
  currentHash: string;
  currentYjsStateBase64: string;
  lastProjectedMarkdown?: string;
  lastProjectedHash?: string;
  lastProviderStateFingerprint?: string;
  updatedAt: string;
}
```

No migration is required because the fields are optional and old metadata remains valid.

- [ ] **Step 4: Run the metadata tests**

Run:

```bash
npx -y pnpm@10.0.0 test apps/api/src/local/local-metadata-store.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/local/local-metadata-store.ts apps/api/src/local/local-metadata-store.test.ts
git commit -m "feat: persist local projection baseline"
```

### Task 3: Make LocalFileService Baseline-Aware

**Files:**
- Modify: `apps/api/src/local/local-file-service.ts`
- Modify: `apps/api/src/local/local-file-service.test.ts`

- [ ] **Step 1: Add failing stale-provider/disk tests**

Add these tests to `apps/api/src/local/local-file-service.test.ts`:

```ts
  it('projects remote provider changes when disk stayed at last projected baseline', async () => {
    const { file, metadataPath } = await createTempMarkdown('# Base\n');
    const service = await createLocalFileServiceWithOptions(file, { metadataPath });
    const loaded = await service.loadRoomState(service.roomName);
    if (!loaded) throw new Error('missing_loaded_state');
    const remote = await runtime.applyChangedRanges({
      branchId: service.getSummary().localDocId,
      yjsState: loaded.yjsState,
      seedMarkdown: '# Base\n',
      targetCanonicalMarkdown: '# Remote\n',
    });

    await service.storeRoomState(service.roomName, remote.yjsState, loaded.stateFingerprint);

    expect(await readFile(file, 'utf8')).toBe('# Remote\n');
    expect(service.getSummary().conflict).toBeNull();
    service.stopWatcher();
  });

  it('does not let stale disk overwrite remote provider changes after restart', async () => {
    const { file, metadataPath } = await createTempMarkdown('# Base\n');
    const first = await createLocalFileServiceWithOptions(file, { metadataPath });
    const loaded = await first.loadRoomState(first.roomName);
    if (!loaded) throw new Error('missing_loaded_state');
    const remote = await runtime.applyChangedRanges({
      branchId: first.getSummary().localDocId,
      yjsState: loaded.yjsState,
      seedMarkdown: '# Base\n',
      targetCanonicalMarkdown: '# Remote while app closed\n',
    });
    first.stopWatcher();

    const restarted = await createLocalFileServiceWithOptions(file, { metadataPath });
    await restarted.storeRoomState(restarted.roomName, remote.yjsState, loaded.stateFingerprint);

    expect(await readFile(file, 'utf8')).toBe('# Remote while app closed\n');
    expect(restarted.getSummary().conflict).toBeNull();
    restarted.stopWatcher();
  });

  it('pauses sync when disk and provider both diverged from last projected baseline', async () => {
    const { file, metadataPath } = await createTempMarkdown('# Base\n');
    const service = await createLocalFileServiceWithOptions(file, { metadataPath });
    const loaded = await service.loadRoomState(service.roomName);
    if (!loaded) throw new Error('missing_loaded_state');
    const remote = await runtime.applyChangedRanges({
      branchId: service.getSummary().localDocId,
      yjsState: loaded.yjsState,
      seedMarkdown: '# Base\n',
      targetCanonicalMarkdown: '# Remote\n',
    });

    await writeFile(file, '# Local\n', 'utf8');
    await service.storeRoomState(service.roomName, remote.yjsState, loaded.stateFingerprint);

    expect(await readFile(file, 'utf8')).toBe('# Local\n');
    expect(service.getSummary().conflict).toBe('File changed outside MarkLab. Review needed.');
    await expect(service.storeRoomState(service.roomName, remote.yjsState, null)).rejects.toThrow('conflict_required');
    service.stopWatcher();
  });
```

- [ ] **Step 2: Run tests and verify current behavior is incomplete**

Run:

```bash
npx -y pnpm@10.0.0 test apps/api/src/local/local-file-service.test.ts
```

Expected: at least one new test fails because the service tracks `lastDiskHash` but not the persisted `lastProjectedMarkdown` baseline.

- [ ] **Step 3: Import reconciliation helper**

Modify the imports at the top of `apps/api/src/local/local-file-service.ts`:

```ts
import { sha256Hex } from '@marklab/shared/src/hash';
import { decideMarkdownReconciliation, normalizeCollabMarkdown } from '@marklab/shared/src/markdown-reconciliation';
```

- [ ] **Step 4: Load stored document and baseline variables**

Replace the existing metadata load block setup with these local variables before `try`:

```ts
  let lastProjectedMarkdown = normalizeCollabMarkdown(initialized.markdown);
  let lastProjectedHash = rawMarkdownHash(lastProjectedMarkdown);
  let lastProviderStateFingerprint = currentStateFingerprint;
```

Inside the `try` block, replace `await metadataStore.loadDocument(absolutePath);` with:

```ts
    const storedDocument = await metadataStore.loadDocument(absolutePath);
    if (storedDocument?.lastProjectedMarkdown !== undefined) {
      lastProjectedMarkdown = normalizeCollabMarkdown(storedDocument.lastProjectedMarkdown);
      lastProjectedHash = storedDocument.lastProjectedHash ?? rawMarkdownHash(lastProjectedMarkdown);
      lastProviderStateFingerprint = storedDocument.lastProviderStateFingerprint ?? currentStateFingerprint;
    }
```

- [ ] **Step 5: Persist the baseline**

In `persistCurrentDocument()`, add the baseline fields:

```ts
      lastProjectedMarkdown,
      lastProjectedHash,
      lastProviderStateFingerprint,
```

- [ ] **Step 6: Add a small baseline update helper**

Add this function near `persistCurrentDocument()`:

```ts
  function markProjectedBaseline(markdown: string, stateFingerprint = currentStateFingerprint): void {
    lastProjectedMarkdown = normalizeCollabMarkdown(markdown);
    lastProjectedHash = rawMarkdownHash(lastProjectedMarkdown);
    lastProviderStateFingerprint = stateFingerprint;
    lastDiskHash = lastProjectedHash;
  }
```

- [ ] **Step 7: Use the helper after successful writes**

In `replaceCurrentStateFromYjs`, replace:

```ts
    lastDiskHash = rawMarkdownHash(serialized.markdown);
```

with:

```ts
    markProjectedBaseline(serialized.markdown, currentStateFingerprint);
```

In `replaceCurrentStateFromMarkdown`, replace:

```ts
    lastDiskHash = rawMarkdownHash(applied.serializedMarkdown);
```

with:

```ts
    markProjectedBaseline(applied.serializedMarkdown, currentStateFingerprint);
```

In `restoreVersion`, replace:

```ts
      lastDiskHash = rawMarkdownHash(applied.serializedMarkdown);
```

with:

```ts
      markProjectedBaseline(applied.serializedMarkdown, currentStateFingerprint);
```

- [ ] **Step 8: Replace provider-to-disk reconciliation**

Replace the body of `applySerializedRoomState` after the `invalid_live_yjs_state` check with:

```ts
    const nextFingerprint = encodeYjsStateFingerprint(serialized.yjsState);
    const diskMarkdown = await readMarkdownFile(absolutePath);
    const decision = decideMarkdownReconciliation({
      lastProjectedMarkdown,
      diskMarkdown,
      providerMarkdown: serialized.markdown,
    });

    if (decision.kind === 'conflict') {
      currentYjsState = serialized.yjsState;
      currentMarkdown = serialized.markdown;
      currentHash = rawMarkdownHash(serialized.markdown);
      currentStateFingerprint = nextFingerprint;
      lastProviderStateFingerprint = nextFingerprint;
      conflict = 'File changed outside MarkLab. Review needed.';
      await createConflictRecoverySnapshot();
      await persistCurrentDocument();
      return;
    }

    currentYjsState = serialized.yjsState;
    currentMarkdown = serialized.markdown;
    currentHash = rawMarkdownHash(serialized.markdown);
    currentStateFingerprint = nextFingerprint;
    lastProviderStateFingerprint = nextFingerprint;

    if (decision.kind === 'noop' || decision.kind === 'ingest_disk_to_provider') {
      conflict = null;
      await persistCurrentDocument();
      return;
    }

    if (decision.kind === 'project_provider_to_disk') {
      await writeMarkdownFileAtomically(absolutePath, decision.markdown);
    }

    if (decision.kind === 'project_provider_to_disk' || decision.kind === 'accept_converged') {
      markProjectedBaseline(decision.markdown, nextFingerprint);
    }

    conflict = null;
    await persistCurrentDocument();
```

- [ ] **Step 9: Replace disk-to-provider reconciliation**

Replace the body of `applyExternalDiskMarkdown` after `const diskHash = rawMarkdownHash(markdown);` with:

```ts
    if (diskHash === lastProjectedHash) return null;

    const decision = decideMarkdownReconciliation({
      lastProjectedMarkdown,
      diskMarkdown: markdown,
      providerMarkdown: currentMarkdown,
    });

    if (decision.kind === 'conflict') {
      conflict = 'File changed outside MarkLab. Review needed.';
      await createConflictRecoverySnapshot();
      await persistCurrentDocument();
      return null;
    }

    if (decision.kind === 'noop') return null;

    if (decision.kind === 'accept_converged') {
      markProjectedBaseline(decision.markdown, currentStateFingerprint);
      conflict = null;
      await persistCurrentDocument();
      return null;
    }

    if (decision.kind === 'project_provider_to_disk') {
      await writeMarkdownFileAtomically(absolutePath, decision.markdown);
      markProjectedBaseline(decision.markdown, currentStateFingerprint);
      conflict = null;
      await persistCurrentDocument();
      return null;
    }

    const applied = await runtime.applyChangedRanges({
      branchId: localDocId,
      yjsState: currentYjsState,
      seedMarkdown: currentMarkdown,
      targetCanonicalMarkdown: decision.markdown,
    });
    if (applied.yjsState.byteLength === 0) throw new Error('invalid_live_yjs_state');

    currentYjsState = applied.yjsState;
    currentMarkdown = applied.serializedMarkdown;
    currentHash = rawMarkdownHash(applied.serializedMarkdown);
    currentStateFingerprint = encodeYjsStateFingerprint(applied.yjsState);
    markProjectedBaseline(applied.serializedMarkdown, currentStateFingerprint);
    conflict = null;
    await persistCurrentDocument();
    return applied.yjsState;
```

- [ ] **Step 10: Run local service tests**

Run:

```bash
npx -y pnpm@10.0.0 test apps/api/src/local/local-file-service.test.ts apps/api/src/local/local-metadata-store.test.ts packages/shared/src/markdown-reconciliation.test.ts
```

Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add apps/api/src/local/local-file-service.ts apps/api/src/local/local-file-service.test.ts
git commit -m "fix: reconcile local files from projected baseline"
```

### Task 4: Add Provider Document Id Storage

**Files:**
- Modify: `apps/api/src/db/schema.sql`
- Create: `apps/api/src/services/provider-doc-service.ts`
- Create: `apps/api/src/services/provider-doc-service.test.ts`

- [ ] **Step 1: Write the provider document service tests**

Create `apps/api/src/services/provider-doc-service.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ensureProviderDocId } from './provider-doc-service';

function createProviderDocPool(existingProviderDocId: string | null = null) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  return {
    calls,
    async query(sql: string, params: unknown[]) {
      calls.push({ sql, params });
      if (/select provider_doc_id/u.test(sql)) {
        return { rows: existingProviderDocId ? [{ provider_doc_id: existingProviderDocId }] : [{ provider_doc_id: null }] };
      }
      if (/update document_branch_states/u.test(sql)) {
        return { rows: [{ provider_doc_id: params[1] }] };
      }
      throw new Error(`unexpected_query:${sql}`);
    },
  };
}

describe('ensureProviderDocId', () => {
  it('reuses an existing opaque provider document id', async () => {
    const pool = createProviderDocPool('ml_doc_existing');
    await expect(ensureProviderDocId(pool, 'branch_1')).resolves.toBe('ml_doc_existing');
    expect(pool.calls).toHaveLength(1);
  });

  it('creates an opaque provider document id when the branch state has none', async () => {
    const pool = createProviderDocPool(null);
    const providerDocId = await ensureProviderDocId(pool, 'branch_1');
    expect(providerDocId).toMatch(/^ml_doc_[0-9a-f-]{36}$/u);
    expect(pool.calls).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
npx -y pnpm@10.0.0 test apps/api/src/services/provider-doc-service.test.ts
```

Expected: FAIL with `Cannot find module './provider-doc-service'`.

- [ ] **Step 3: Add schema fields**

Append this SQL near the existing `document_branch_states` alterations in `apps/api/src/db/schema.sql`:

```sql
alter table document_branch_states
  add column if not exists provider_doc_id text;

create unique index if not exists document_branch_states_provider_doc_id_idx
  on document_branch_states (provider_doc_id)
  where provider_doc_id is not null;

create table if not exists provider_token_issuances (
  id uuid primary key default gen_random_uuid(),
  doc_id uuid not null references documents(id) on delete cascade,
  branch_id uuid not null references document_branches(id) on delete cascade,
  provider_doc_id text not null,
  session_id text not null,
  client_kind text not null check (client_kind in ('browser', 'app', 'daemon', 'agent', 'guest')),
  authorization text not null check (authorization in ('full', 'read-only')),
  valid_for_seconds integer not null,
  issued_at timestamptz not null default now()
);

create index if not exists provider_token_issuances_branch_issued_idx
  on provider_token_issuances (branch_id, issued_at desc);
```

- [ ] **Step 4: Implement provider document service**

Create `apps/api/src/services/provider-doc-service.ts`:

```ts
import { randomUUID } from 'node:crypto';
import type { DbExecutor } from '../db/client';

export async function ensureProviderDocId(pool: DbExecutor, branchId: string): Promise<string> {
  const existing = await pool.query<{ provider_doc_id: string | null }>(
    `select provider_doc_id
       from document_branch_states
      where branch_id = $1`,
    [branchId],
  );

  const providerDocId = existing.rows[0]?.provider_doc_id;
  if (providerDocId) return providerDocId;

  const generated = `ml_doc_${randomUUID()}`;
  const updated = await pool.query<{ provider_doc_id: string }>(
    `update document_branch_states
        set provider_doc_id = $2,
            updated_at = updated_at
      where branch_id = $1
      returning provider_doc_id`,
    [branchId, generated],
  );

  const row = updated.rows[0];
  if (!row) throw new Error('branch_not_found');
  return row.provider_doc_id;
}

export async function recordProviderTokenIssuance(pool: DbExecutor, input: {
  docId: string;
  branchId: string;
  providerDocId: string;
  sessionId: string;
  clientKind: 'browser' | 'app' | 'daemon' | 'agent' | 'guest';
  authorization: 'full' | 'read-only';
  validForSeconds: number;
}): Promise<void> {
  await pool.query(
    `insert into provider_token_issuances
       (doc_id, branch_id, provider_doc_id, session_id, client_kind, authorization, valid_for_seconds)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.docId,
      input.branchId,
      input.providerDocId,
      input.sessionId,
      input.clientKind,
      input.authorization,
      input.validForSeconds,
    ],
  );
}
```

- [ ] **Step 5: Run provider document service tests**

Run:

```bash
npx -y pnpm@10.0.0 test apps/api/src/services/provider-doc-service.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/db/schema.sql apps/api/src/services/provider-doc-service.ts apps/api/src/services/provider-doc-service.test.ts
git commit -m "feat: store provider document ids"
```

### Task 5: Add Y-Sweet Token Service

**Files:**
- Modify: `apps/api/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `apps/api/src/provider/ysweet-token-service.ts`
- Create: `apps/api/src/provider/ysweet-token-service.test.ts`

- [ ] **Step 1: Add Y-Sweet SDK dependency**

Run:

```bash
npx -y pnpm@10.0.0 --filter @marklab/api add @y-sweet/sdk@0.9.1
```

Expected: `apps/api/package.json` includes `@y-sweet/sdk` and `pnpm-lock.yaml` is updated.

- [ ] **Step 2: Write Y-Sweet token service tests**

Create `apps/api/src/provider/ysweet-token-service.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createYSweetTokenService, type YSweetDocumentManagerLike } from './ysweet-token-service';

function createFakeManager(): YSweetDocumentManagerLike & { calls: Array<{ docId?: string; authorization?: string; validForSeconds?: number }> } {
  const calls: Array<{ docId?: string; authorization?: string; validForSeconds?: number }> = [];
  return {
    calls,
    async getOrCreateDocAndToken(docId, request) {
      calls.push({ docId, authorization: request?.authorization, validForSeconds: request?.validForSeconds });
      return {
        url: 'ws://ysweet.example.test',
        baseUrl: 'http://ysweet.example.test/doc/ml_doc_1',
        docId: docId ?? 'ml_doc_generated',
        token: 'ysweet_token',
        authorization: request?.authorization,
      };
    },
  };
}

describe('createYSweetTokenService', () => {
  it('issues full edit tokens with a 10 minute default ttl', async () => {
    const manager = createFakeManager();
    const service = createYSweetTokenService({ manager });

    const issued = await service.issueProviderToken({
      providerDocId: 'ml_doc_1',
      sessionId: 'session_1',
      authorization: 'full',
    });

    expect(manager.calls).toEqual([{ docId: 'ml_doc_1', authorization: 'full', validForSeconds: 600 }]);
    expect(issued).toMatchObject({
      providerDocId: 'ml_doc_1',
      sessionId: 'session_1',
      authorization: 'full',
      validForSeconds: 600,
      clientToken: {
        docId: 'ml_doc_1',
        token: 'ysweet_token',
      },
    });
  });

  it('passes read-only authorization and explicit ttl through to Y-Sweet', async () => {
    const manager = createFakeManager();
    const service = createYSweetTokenService({ manager, defaultValidForSeconds: 600 });

    const issued = await service.issueProviderToken({
      providerDocId: 'ml_doc_2',
      sessionId: 'session_2',
      authorization: 'read-only',
      validForSeconds: 120,
    });

    expect(manager.calls).toEqual([{ docId: 'ml_doc_2', authorization: 'read-only', validForSeconds: 120 }]);
    expect(issued.authorization).toBe('read-only');
    expect(issued.validForSeconds).toBe(120);
  });
});
```

- [ ] **Step 3: Run test and verify it fails**

Run:

```bash
npx -y pnpm@10.0.0 test apps/api/src/provider/ysweet-token-service.test.ts
```

Expected: FAIL with `Cannot find module './ysweet-token-service'`.

- [ ] **Step 4: Implement the token service**

Create `apps/api/src/provider/ysweet-token-service.ts`:

```ts
import { DocumentManager, type ClientToken } from '@y-sweet/sdk';

export type ProviderAuthorization = 'full' | 'read-only';

export interface YSweetDocumentManagerLike {
  getOrCreateDocAndToken(
    docId?: string,
    request?: { authorization?: ProviderAuthorization; validForSeconds?: number },
  ): Promise<ClientToken>;
}

export interface IssueProviderTokenInput {
  providerDocId: string;
  sessionId: string;
  authorization: ProviderAuthorization;
  validForSeconds?: number;
}

export interface IssuedProviderToken {
  providerDocId: string;
  sessionId: string;
  authorization: ProviderAuthorization;
  validForSeconds: number;
  issuedAt: string;
  expiresAt: string;
  clientToken: ClientToken;
}

export interface ProviderTokenService {
  issueProviderToken(input: IssueProviderTokenInput): Promise<IssuedProviderToken>;
}

export function createYSweetTokenService(input: {
  connectionString?: string;
  manager?: YSweetDocumentManagerLike;
  defaultValidForSeconds?: number;
} = {}): ProviderTokenService {
  const manager = input.manager ?? new DocumentManager(input.connectionString ?? requiredConnectionString());
  const defaultValidForSeconds = input.defaultValidForSeconds ?? 600;

  return {
    async issueProviderToken(request) {
      const validForSeconds = request.validForSeconds ?? defaultValidForSeconds;
      const issuedAtMs = Date.now();
      const clientToken = await manager.getOrCreateDocAndToken(request.providerDocId, {
        authorization: request.authorization,
        validForSeconds,
      });

      return {
        providerDocId: request.providerDocId,
        sessionId: request.sessionId,
        authorization: request.authorization,
        validForSeconds,
        issuedAt: new Date(issuedAtMs).toISOString(),
        expiresAt: new Date(issuedAtMs + validForSeconds * 1000).toISOString(),
        clientToken,
      };
    },
  };
}

function requiredConnectionString(): string {
  const value = process.env.MARKLAB_YSWEET_CONNECTION_STRING;
  if (!value?.trim()) throw new Error('ysweet_connection_string_not_configured');
  return value;
}
```

- [ ] **Step 5: Run token service tests**

Run:

```bash
npx -y pnpm@10.0.0 test apps/api/src/provider/ysweet-token-service.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/package.json pnpm-lock.yaml apps/api/src/provider/ysweet-token-service.ts apps/api/src/provider/ysweet-token-service.test.ts
git commit -m "feat: add ysweet provider token service"
```

### Task 6: Add Collab Session Route Contract

**Files:**
- Create: `apps/api/src/routes/collab-session-routes.ts`
- Create: `apps/api/src/routes/collab-session-routes.test.ts`
- Modify: `apps/api/src/http/app.ts`

- [ ] **Step 1: Write route tests**

Create `apps/api/src/routes/collab-session-routes.test.ts`:

```ts
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createHttpApp, type HttpRequestAuth } from '../http/app';
import type { ProviderTokenService } from '../provider/ysweet-token-service';
import type { LiveMarkdownWriter } from '../services/live-writer';

function createPool() {
  return {
    async query(sql: string, params: unknown[]) {
      if (/select provider_doc_id/u.test(sql)) return { rows: [{ provider_doc_id: 'ml_doc_existing' }] };
      if (/insert into provider_token_issuances/u.test(sql)) return { rows: [] };
      if (/from documents d/u.test(sql)) {
        return {
          rows: [{
            doc_id: params[0],
            branch_id: params[1],
            version_id: 'version_1',
            version_number: 1,
            current_hash: 'sha256:markdown',
            current_markdown: '# Visible\n',
          }],
        };
      }
      throw new Error(`unexpected_query:${sql}`);
    },
  };
}

function createAuth(): HttpRequestAuth & { operations: string[] } {
  const operations: string[] = [];
  return {
    operations,
    async requireAdminAccess() {},
    async requireDocumentAccess(_req, _docId, _branchId, operation) {
      operations.push(operation);
      return { actorType: 'user' };
    },
  };
}

function createProviderTokenService(): ProviderTokenService & { issued: unknown[] } {
  const issued: unknown[] = [];
  return {
    issued,
    async issueProviderToken(input) {
      issued.push(input);
      return {
        providerDocId: input.providerDocId,
        sessionId: input.sessionId,
        authorization: input.authorization,
        validForSeconds: input.validForSeconds ?? 600,
        issuedAt: '2026-05-11T00:00:00.000Z',
        expiresAt: '2026-05-11T00:10:00.000Z',
        clientToken: {
          url: 'ws://ysweet.example.test',
          baseUrl: 'http://ysweet.example.test/doc/ml_doc_existing',
          docId: input.providerDocId,
          token: 'ysweet_token',
          authorization: input.authorization,
        },
      };
    },
  };
}

const unavailableWriter: LiveMarkdownWriter = {
  async applyMarkdownTransaction() {
    throw new Error('not_used');
  },
};

describe('collab session routes', () => {
  it('issues an edit provider token only after write access succeeds', async () => {
    const auth = createAuth();
    const providerTokenService = createProviderTokenService();
    const app = createHttpApp(createPool() as never, unavailableWriter, { auth, providerTokenService });

    const response = await request(app)
      .post('/api/docs/doc_1/branches/branch_1/collab/session')
      .send({ mode: 'edit', clientKind: 'browser', displayName: 'Alice' })
      .expect(201);

    expect(auth.operations).toEqual(['write']);
    expect(providerTokenService.issued).toEqual([expect.objectContaining({
      providerDocId: 'ml_doc_existing',
      authorization: 'full',
      validForSeconds: 600,
    })]);
    expect(response.body.providerToken.clientToken.token).toBe('ysweet_token');
    expect(response.body.providerToken.clientToken.authorization).toBe('full');
  });

  it('returns a public view snapshot without provider credentials', async () => {
    const auth = createAuth();
    const providerTokenService = createProviderTokenService();
    const app = createHttpApp(createPool() as never, unavailableWriter, { auth, providerTokenService });

    const response = await request(app)
      .post('/api/docs/doc_1/branches/branch_1/collab/session')
      .send({ mode: 'view', clientKind: 'guest', displayName: 'Guest' })
      .expect(200);

    expect(auth.operations).toEqual(['read']);
    expect(providerTokenService.issued).toEqual([]);
    expect(response.body).toMatchObject({
      mode: 'view',
      document: {
        markdown: '# Visible\n',
        hash: 'sha256:markdown',
      },
    });
    expect(response.body.providerToken).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the route tests and verify they fail**

Run:

```bash
npx -y pnpm@10.0.0 test apps/api/src/routes/collab-session-routes.test.ts
```

Expected: FAIL with 404 or missing `providerTokenService` type because the route is not mounted.

- [ ] **Step 3: Add route options to HttpAppOptions**

Modify `apps/api/src/http/app.ts` imports:

```ts
import { createCollabSessionRoutes } from '../routes/collab-session-routes';
import type { ProviderTokenService } from '../provider/ysweet-token-service';
```

Add to `HttpAppOptions`:

```ts
  providerTokenService?: ProviderTokenService;
```

- [ ] **Step 4: Mount the route in hosted mode**

In `createHttpApp`, inside the non-local `else` branch before `createVersionRoutes`, add:

```ts
    app.use('/api', createCollabSessionRoutes(pool, routeOptions));
```

- [ ] **Step 5: Implement the route**

Create `apps/api/src/routes/collab-session-routes.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { DbPool } from '../db/client';
import type { HttpAppOptions } from '../http/app';
import { readBranchState } from '../services/doc-read';
import { ensureProviderDocId, recordProviderTokenIssuance } from '../services/provider-doc-service';

const collabSessionSchema = z.object({
  mode: z.enum(['view', 'edit']),
  clientKind: z.enum(['browser', 'app', 'daemon', 'agent', 'guest']).default('browser'),
  displayName: z.string().trim().min(1).max(80).default('Guest'),
  sessionId: z.string().trim().min(1).optional(),
});

function requiredParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || !value) throw new Error(`missing_route_param:${name}`);
  return value;
}

function requireProviderTokenService(options: HttpAppOptions) {
  if (!options.providerTokenService) throw new Error('provider_token_service_not_configured');
  return options.providerTokenService;
}

export function createCollabSessionRoutes(pool: DbPool, options: HttpAppOptions = {}) {
  const router = Router();

  router.post('/docs/:docId/branches/:branchId/collab/session', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const docId = requiredParam(req, 'docId');
      const branchId = requiredParam(req, 'branchId');
      const body = collabSessionSchema.parse(req.body);
      const sessionId = body.sessionId ?? `session_${randomUUID()}`;

      if (body.mode === 'view') {
        await options.auth?.requireDocumentAccess(req, docId, branchId, 'read');
        const document = await readBranchState(pool, docId, branchId);
        res.status(200).json({
          mode: 'view',
          session: {
            sessionId,
            clientKind: body.clientKind,
            displayName: body.displayName,
          },
          document: {
            docId: document.docId,
            branchId: document.branchId,
            versionId: document.versionId,
            versionNumber: document.versionNumber,
            hash: document.hash,
            markdown: document.markdown,
          },
        });
        return;
      }

      await options.auth?.requireDocumentAccess(req, docId, branchId, 'write');
      const providerDocId = await ensureProviderDocId(pool, branchId);
      const providerTokenService = requireProviderTokenService(options);
      const providerToken = await providerTokenService.issueProviderToken({
        providerDocId,
        sessionId,
        authorization: 'full',
        validForSeconds: 600,
      });
      await recordProviderTokenIssuance(pool, {
        docId,
        branchId,
        providerDocId,
        sessionId,
        clientKind: body.clientKind,
        authorization: 'full',
        validForSeconds: providerToken.validForSeconds,
      });

      res.status(201).json({
        mode: 'edit',
        session: {
          sessionId,
          clientKind: body.clientKind,
          displayName: body.displayName,
        },
        providerToken,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
```

- [ ] **Step 6: Add error mapping**

In `apps/api/src/http/app.ts`, add this near the existing `live_writer_not_configured` handler:

```ts
  if (error instanceof Error && error.message === 'provider_token_service_not_configured') {
    res.status(503).json({ error: 'provider_token_service_not_configured' });
    return;
  }
```

- [ ] **Step 7: Run route tests**

Run:

```bash
npx -y pnpm@10.0.0 test apps/api/src/routes/collab-session-routes.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/routes/collab-session-routes.ts apps/api/src/routes/collab-session-routes.test.ts apps/api/src/http/app.ts
git commit -m "feat: add collab session route contract"
```

### Task 6B: Add Provider Token Refresh Contract

**Files:**
- Modify: `apps/api/src/routes/collab-session-routes.ts`
- Modify: `apps/api/src/routes/collab-session-routes.test.ts`

- [ ] **Step 1: Add refresh route tests**

Extend `apps/api/src/routes/collab-session-routes.test.ts` with tests that prove:

- `POST /api/docs/:docId/branches/:branchId/collab/session/:sessionId/provider-token/refresh` requires write access.
- A successful refresh returns a fresh Y-Sweet `ClientToken` with `authorization: "full"` and `validForSeconds: 600`.
- A denied write access check returns no provider token and does not call `issueProviderToken`.

- [ ] **Step 2: Implement refresh route**

Add a route to `createCollabSessionRoutes` that:

- Reads `docId`, `branchId`, and `sessionId` from route params.
- Calls `options.auth?.requireDocumentAccess(req, docId, branchId, 'write')`.
- Resolves the existing branch `providerDocId` with `ensureProviderDocId(pool, branchId)`.
- Calls `providerTokenService.issueProviderToken({ providerDocId, sessionId, authorization: 'full', validForSeconds: 600 })`.
- Records a provider-token issuance row with the same `sessionId`.
- Returns `{ providerToken }`.

- [ ] **Step 3: Run route tests**

Run:

```bash
npx -y pnpm@10.0.0 test apps/api/src/routes/collab-session-routes.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/collab-session-routes.ts apps/api/src/routes/collab-session-routes.test.ts
git commit -m "feat: add provider token refresh contract"
```

### Task 7: Full Verification

**Files:**
- All files changed in Tasks 1-6B.

- [ ] **Step 1: Run targeted tests**

Run:

```bash
npx -y pnpm@10.0.0 test \
  packages/shared/src/markdown-reconciliation.test.ts \
  apps/api/src/local/local-metadata-store.test.ts \
  apps/api/src/local/local-file-service.test.ts \
  apps/api/src/services/provider-doc-service.test.ts \
  apps/api/src/provider/ysweet-token-service.test.ts \
  apps/api/src/routes/collab-session-routes.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run API typecheck**

Run:

```bash
npx -y pnpm@10.0.0 exec tsc --noEmit -p apps/api/tsconfig.json
```

Expected: no TypeScript errors.

- [ ] **Step 3: Run shared typecheck**

Run:

```bash
npx -y pnpm@10.0.0 exec tsc --noEmit -p packages/shared/tsconfig.json
```

Expected: no TypeScript errors.

- [ ] **Step 4: Run diff hygiene**

Run:

```bash
git diff --check
```

Expected: no whitespace errors.

- [ ] **Step 5: Confirm view sessions still have no provider credentials**

Run:

```bash
rg -n "mode: 'view'|mode === 'view'|providerToken" apps/api/src/routes/collab-session-routes.ts apps/api/src/routes/collab-session-routes.test.ts
```

Expected: route test confirms `providerToken` is undefined for view mode, and route implementation returns before calling `issueProviderToken`.

- [ ] **Step 6: Commit verification fixes**

If any verification command required code changes, commit them:

```bash
git add packages/shared/src apps/api/src apps/api/package.json pnpm-lock.yaml
git commit -m "test: verify ysweet collaboration foundation"
```

If no verification fixes were needed, do not create an empty commit.

## Self-Review Checklist

- [ ] `lastProjectedMarkdown` is persisted and loaded; `lastDiskHash` alone is no longer the reconnect baseline.
- [ ] Provider-to-disk projection does not overwrite a locally changed disk file when provider also changed.
- [ ] Disk-to-provider ingestion does not overwrite provider changes when disk also changed.
- [ ] Both-sides-changed cases pause sync and require conflict handling.
- [ ] Public view sessions do not receive Y-Sweet provider credentials.
- [ ] Edit sessions receive Y-Sweet native `ClientToken`s with `authorization: "full"` and `validForSeconds: 600`.
- [ ] Server records provider token issuance metadata for audit; it does not rely on `Y.PermanentUserData` as authoritative audit data.
- [ ] Provider document ids are opaque and do not encode file path, filename, workspace, or user identity.
- [ ] All new behavior is covered by Vitest tests and TypeScript checks.
