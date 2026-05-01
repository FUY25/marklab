# MVP Launch Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to run this checklist. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify the MVP is ready for a small controlled product launch.

**Architecture:** This is a cross-plan gate, not a feature implementation plan. It runs automated tests, browser E2E, CLI/agent smoke, deployment smoke, and manual QA against one environment.

**Tech Stack:** Vitest, Playwright, MarkLab CLI, smoke scripts, deployed Node/Postgres/WebSocket environment.

---

## Scope Check

This plan does not add new product features. Any failure here must create a bugfix PR or a new explicit plan before launch.

## Required Completed Plans

```text
Plan 1: Foundation repo and shared utilities
Plan 2: Milkdown/Crepe editor and local collab harness
Plan 3: Hocuspocus backend and Yjs persistence
Plan 4: Import/export and shared read service
Plan 5: Version service and routes
Plan 6: AI read/write/edit API
Plan 6.2: Concrete Milkdown transformer and live writer
Plan 6.3: Web remote document mode
Plan 6.4: Web document lifecycle UI
Plan 6.5: Web version/branch UI
Plan 6.6: Access tokens and share links
Plan 7: CLI and agent skill
Plan 8: Deployment
Plan 8.1: Deployment hardening and operations
```

## Task 1: Automated test gate

**Files:**
- Review test output only.

- [ ] **Step 1: Run full unit/integration tests**

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

- [ ] **Step 3: Run browser E2E**

Run:

```bash
MARKLAB_REQUIRE_AUTH=true TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/marklab_test npx -y pnpm@10.0.0 --filter @marklab/web test:e2e
```

Expected: PASS.

## Task 2: Product workflow gate

**Files:**
- Review browser and CLI behavior.

- [ ] **Step 1: Manual browser create/import/export**

Verify:

```text
Create blank doc from root page.
Import a Markdown fixture from root page.
Export the imported doc.
Downloaded filename includes doc id, branch slug, version number, timestamp, and hash prefix.
Exported body hash matches filename hash prefix.
```

- [ ] **Step 2: Manual two-window collaboration**

Verify:

```text
Two browser windows open the same /docs/:docId/branches/:branchId URL.
Window A edits; Window B sees it without refresh.
Window B edits; Window A sees it without refresh.
Presence shows both connected users or an equivalent connected state.
```

- [ ] **Step 3: Manual API/agent write visibility**

Verify:

```text
Run marklab read-doc.
Run marklab edit-doc for one exact replacement.
Both browser windows see the edit without refresh.
Run marklab write-doc with a fresh baseVersionId/baseHash.
Both browser windows see the full-write result without refresh.
Run write-doc again with the old base and confirm live_yjs_state_changed or stale_base_version.
```

- [ ] **Step 4: Manual version and branch UI**

Verify:

```text
Version panel shows create/import/edit/write entries.
Old version preview opens.
Branch from old version opens a separate branch URL.
Restoring an old version creates a new rollback version and does not delete history.
Main and branch content stay isolated.
```

- [ ] **Step 5: Manual access control**

Verify:

```text
Create edit share link and open it in a private browser context.
Create read-only share link and confirm editing is blocked.
Create write-capable agent token and use CLI read/edit/write.
Revoke the token and confirm CLI read fails.
Unauthenticated document access fails when MARKLAB_REQUIRE_AUTH=true.
Unauthenticated create/import and access-management fail when MARKLAB_REQUIRE_AUTH=true.
Admin/bootstrap token can create/import and manage document tokens in the controlled MVP environment.
```

## Task 3: Deployment smoke gate

**Files:**
- Review deployed environment.

- [ ] **Step 1: Run readiness checks**

Run against the deployed API:

```bash
curl -fsS "$MARKLAB_API_URL/healthz"
curl -fsS "$MARKLAB_API_URL/readyz"
```

Expected: both succeed.

- [ ] **Step 2: Run MVP smoke script**

Run:

```bash
MARKLAB_API_URL="$MARKLAB_API_URL" MARKLAB_TOKEN="$MARKLAB_TOKEN" node scripts/smoke-mvp.mjs
```

Expected: script exits 0 and prints final doc/version/export metadata.

- [ ] **Step 3: Browser smoke deployed app**

Verify:

```text
Open deployed web app.
Create/import a document.
Open the same document in a second browser.
Confirm realtime sync.
Export from deployed app.
```

## Task 4: Launch blockers review

**Files:**
- Review `09_mvp_launch_gap_matrix.md`

- [ ] **Step 1: Confirm no MVP blockers remain**

For every "Required before MVP launch" row in `09_mvp_launch_gap_matrix.md`, confirm:

```text
Implemented.
Tested.
Documented.
No unresolved P0/P1 bugs.
```

- [ ] **Step 2: Record known limitations**

Known limitations must be visible in release notes or runbook:

```text
No org/team RBAC.
No billing.
No local bidirectional sync.
No GitHub sync.
No MCP adapter.
No in-app AI diff UI.
No image upload/storage.
No comments/reactions.
```

## Launch Gate

MVP launch can proceed only when:

```text
All automated tests pass.
Browser remote-document E2E passes.
CLI/agent workflow passes against the deployed API.
Auth-required mode is enabled and verified.
Admin/bootstrap token is configured and stored outside the repository.
Postgres backup policy is in place.
Runbook is current.
No P0/P1 issue remains open.
```
