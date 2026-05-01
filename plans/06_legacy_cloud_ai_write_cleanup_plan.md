# Legacy Cloud And Hosted AI Write Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove or quarantine the legacy cloud-document and hosted-AI-write product paths so MarkLab stays lean around local files, relay sharing, and local-agent file edits.

**Architecture:** Keep the Markdown transformer, LiveMarkdownWriter internals, and Yjs utilities that are still useful for local sync and relay. Remove or isolate cloud-first document routes, branch UI, import/new dashboards, hosted AI write/edit endpoints, agent token routes, and hidden toolbar surfaces that no longer match the product. The default app should have one local-first path and one relay collaboration path.

**Tech Stack:** TypeScript API routes, React web UI, CLI, Vitest, Playwright, archived cloud-first plans as reference only.

---

## Product Scope

This plan starts after Plan 01 through Plan 05 define the new local-first product surface.

In scope:

- remove hosted AI write/edit routes from mounted default app;
- remove or quarantine cloud document create/import/read/write routes;
- remove branch UI and branch assumptions from default web UI;
- remove agent-token UI and API;
- remove hidden toolbar/import/new controls that imply cloud document storage;
- split reusable Markdown/Yjs utilities from legacy cloud document services;
- update tests to assert legacy paths are unavailable by default;
- keep archived cloud-first plans as reference.

Out of scope:

- deleting Milkdown runtime or Markdown transformer code used by local sync;
- deleting relay routes from Plan 02;
- deleting local version/snapshot behavior;
- building a new cloud document product;
- preserving legacy cloud routes in production.

## Cleanup Principles

- Local-first path is the default product.
- Hosted relay is transport and access, not document storage.
- AI agents operate MarkLab through CLI and edit local files.
- There is no hosted AI content-write API in the lean product.
- Branch UI is removed from default UX.
- Import/new cloud document flows are removed from default UX.
- Legacy cloud-first code may remain temporarily only behind an explicit `MARKLAB_ENABLE_LEGACY_CLOUD=true` flag during migration, and then should be deleted.
- Tests should fail if default local/relay mode accidentally remounts legacy write routes.

## Legacy Surfaces To Audit

Known candidates from the current tree:

```text
apps/api/src/routes/doc-ai-routes.ts
apps/api/src/routes/doc-ai-routes.test.ts
apps/api/src/routes/doc-ai-routes.e2e.test.ts
apps/api/src/routes/doc-ai-routes.real-db.e2e.test.ts
apps/api/src/routes/import-export-routes.ts
apps/api/src/routes/access-routes.ts
apps/api/src/services/doc-create.ts
apps/api/src/services/doc-read.ts
apps/api/src/services/doc-write.ts
apps/api/src/services/version-service.ts
apps/api/src/collab/persistence.ts
apps/web/src/pages/RemoteDocumentPage.tsx
apps/web/src/components/BranchSwitcher.tsx
apps/web/src/components/DocumentToolbar.tsx
apps/web/src/components/ShareAccessPanel.tsx
apps/web/src/components/VersionHistoryPanel.tsx
apps/web/src/components/VersionsDrawer.tsx
apps/web/src/components/DocumentActionRail.tsx
apps/web/src/lib/api-client.ts
apps/web/src/routes.ts
README.md
00_scope_and_decisions.md
01_product_requirements.md
02_architecture_milkdown_first.md
03_canonical_markdown_contract.md
04_data_model_and_api.md
05_ai_write_versioning_branching.md
06_testing_strategy.md
07_risks_and_attention.md
08_references.md
09_mvp_launch_gap_matrix.md
```

This list is an audit starting point, not an instruction to delete every file. Keep reusable pieces that local sync or relay still need.

## Target Default Surface

Default local product:

```text
marklab open README.md
marklab status
marklab save-version
marklab wait
marklab doctor
```

Default relay product:

```text
marklab share README.md
marklab create-link README.md --role view
marklab create-link README.md --role edit
marklab share-state README.md
marklab join <edit-link> --dir ./docs --name README.md
```

Default web product:

```text
/local
/relay/<relayRoomId> or equivalent relay route
clean editor canvas
Versions
Share
Conflict review
```

Unavailable by default:

```text
/api/docs/:docId/branches/:branchId/write
/api/docs/:docId/branches/:branchId/edit
/api/docs/import
/api/docs/:docId/branches
/api/docs/:docId/branches/:branchId/agent-tokens
cloud document dashboard
branch switcher
cloud import/new actions
hosted AI write/edit CLI
```

## Task 1: Legacy Surface Inventory

**Files:**

- Create: `docs/legacy-cleanup/inventory.md`
- Modify: `plans/06_legacy_cloud_ai_write_cleanup_plan.md` only if inventory reveals a missing category.

- [ ] List every API route mounted by `apps/api/src/http/app.ts`.
- [ ] List every web route parsed by `apps/web/src/routes.ts`.
- [ ] List every CLI command exposed by `apps/cli/marklab.mjs`.
- [ ] Classify each surface as:
  - `keep-local`;
  - `keep-relay`;
  - `reuse-internal`;
  - `legacy-quarantine`;
  - `delete`.
- [ ] Record why each `reuse-internal` item is still needed.

Acceptance criteria:

- Inventory includes file path and route/command name.
- No legacy route is removed before it is classified.
- Inventory identifies tests that must be deleted, rewritten, or replaced.

## Task 2: API Route Quarantine And Removal

**Files:**

- Modify: `apps/api/src/http/app.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/src/routes/doc-ai-routes.ts`
- Modify or delete: `apps/api/src/routes/import-export-routes.ts`
- Modify or delete: `apps/api/src/routes/access-routes.ts`
- Test: `apps/api/src/http/app.legacy-cleanup.test.ts`

- [ ] Add default route tests proving hosted AI write/edit routes are unavailable.
- [ ] Add default route tests proving cloud import/new/branch routes are unavailable.
- [ ] Add default route tests proving local routes still work in local mode.
- [ ] Add default route tests proving relay routes still work when Plan 02 relay mode is enabled.
- [ ] Remove mounted legacy routes from default app.
- [ ] If a temporary `MARKLAB_ENABLE_LEGACY_CLOUD=true` escape hatch is needed for migration, isolate it in one function and mark it for deletion in this plan.

Acceptance criteria:

- Default app does not mount hosted AI write/edit endpoints.
- Default app does not mount agent-token endpoints.
- Default app does not mount cloud import/create routes.
- Local and relay modes do not require cloud document tables.
- Legacy route tests are removed or rewritten so they no longer define the current product.

## Task 3: Service Boundary Cleanup

**Files:**

- Modify: `apps/api/src/services/live-writer.ts`
- Modify: `apps/api/src/services/editor-state.ts`
- Modify: `apps/api/src/services/doc-write.ts`
- Modify: `apps/api/src/services/doc-create.ts`
- Modify: `apps/api/src/services/doc-read.ts`
- Modify: `apps/api/src/services/version-service.ts`
- Test: `apps/api/src/services/live-writer.test.ts`
- Test: `apps/api/src/local/local-file-service.test.ts`

- [ ] Keep LiveMarkdownWriter or equivalent runtime path only where local sync, restore, relay acceptance, and conflict resolution need it.
- [ ] Remove cloud document write service entrypoints from default imports.
- [ ] Keep Markdown/Yjs helpers in neutral modules that do not mention branches or hosted AI.
- [ ] Replace local-file uses of `branchId` naming with `localDocId` or `roomId` naming where practical.
- [ ] Ensure local version operations do not use cloud operation names such as hosted `write` or `edit`.

Acceptance criteria:

- Local sync tests pass without importing `doc-write.ts`.
- Relay tests pass without importing hosted AI write route handlers.
- No default local/relay code path writes `document_branch_states`.

## Task 4: Web UI Lean Cleanup

**Files:**

- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/routes.ts`
- Modify: `apps/web/src/lib/api-client.ts`
- Modify or delete: `apps/web/src/pages/RemoteDocumentPage.tsx`
- Modify or delete: `apps/web/src/components/BranchSwitcher.tsx`
- Modify or delete: `apps/web/src/components/DocumentToolbar.tsx`
- Modify or delete: `apps/web/src/components/ShareAccessPanel.tsx`
- Modify: `apps/web/src/components/DocumentActionRail.tsx`
- Modify: `apps/web/src/components/VersionsDrawer.tsx`
- Test: `apps/web/tests/local-file-sync.spec.ts`
- Test: `apps/web/tests/relay-collaboration.spec.ts`

- [ ] Remove branch switcher from default UI.
- [ ] Remove cloud import/new controls from default UI.
- [ ] Remove admin-token setup from default UI.
- [ ] Remove hosted agent-token UI.
- [ ] Ensure local page shows only editor, Versions, Share when relay-enabled, and conflict status.
- [ ] Ensure relay browser page shows only role-appropriate editor/read-only UI and status.
- [ ] Split API client into local/relay clients so cloud branch methods are not imported by default pages.

Acceptance criteria:

- No hidden toolbar exposes cloud import/new/branch actions.
- View-only relay page never mounts editable provider.
- Local page does not import cloud document APIs.
- Browser route parser does not route users into legacy cloud documents by default.

## Task 5: CLI Legacy Cleanup

**Files:**

- Modify: `apps/cli/marklab.mjs`
- Modify: `apps/cli/agent-instructions.mjs`
- Test: `apps/cli/marklab-cli.test.mjs`
- Test: `apps/cli/agent-instructions.test.mjs`

- [ ] Remove hosted AI write/edit commands if present.
- [ ] Ensure `marklab agent instructions` does not mention hosted write/edit APIs.
- [ ] Ensure `marklab share`, `marklab join`, `marklab status`, `marklab wait`, and `marklab save-version` remain.
- [ ] Add tests proving `marklab write`, `marklab edit`, `marklab hosted-write`, and `marklab hosted-edit` are rejected if invoked.

Acceptance criteria:

- CLI controls MarkLab process and metadata only.
- CLI does not provide content-write commands.
- AI docs and CLI help agree on local-file editing.

## Task 6: Test Suite Pruning And Replacement

**Files:**

- Modify or delete legacy tests under `apps/api/src/routes/*doc-ai*`
- Modify or delete legacy tests under `apps/api/src/routes/*import-export*`
- Modify web tests that assume cloud document dashboard.
- Create: `apps/api/src/http/app.legacy-cleanup.test.ts`
- Create: `apps/web/tests/no-legacy-cloud-ui.spec.ts`

- [ ] Delete tests whose only purpose is to preserve hosted AI write/edit APIs.
- [ ] Replace them with tests proving those APIs are unavailable by default.
- [ ] Keep transformer/runtime tests that local sync still depends on.
- [ ] Keep restore/live-writer correctness tests if they cover local/relay restore behavior.
- [ ] Add web regression test proving hidden legacy toolbar controls are absent.

Acceptance criteria:

- Test names match the local-first product behavior.
- No test requires a cloud document to prove the local-first default works.
- Legacy cleanup does not reduce coverage of Markdown round trip, Yjs state validity, local restore, or relay write gating.

## Task 7: Documentation And Archive Links

**Files:**

- Modify: `README.md`
- Modify: `docs/product/local-first-user-journeys.md`
- Create or modify: `plans/Archive/cloud-first-reference/README.md`
- Create: `docs/legacy-cleanup/removed-surfaces.md`
- Modify or archive: root legacy spec docs `00_*.md` through `09_*.md`

- [ ] Document removed legacy routes and replacement local/relay workflows.
- [ ] Link archived cloud-first plans as reference only.
- [ ] Explain that historical branch/version code was superseded by local snapshots and relay sessions.
- [ ] Explain that AI agents now use CLI control plus local file edits.
- [ ] Add a first-screen historical-reference banner to every root legacy spec that remains in place.

Acceptance criteria:

- No current doc presents cloud document branch editing as the main product.
- No current doc tells AI agents to call hosted write/edit endpoints.
- Archive index makes it clear old plans are not active execution plans.
- No root-level Markdown file can be mistaken for the current product direction.
- Every superseded cloud-first root spec starts with `Historical cloud-first reference. Superseded by plans/01 through plans/06 local-first product plans.`

## Verification

Minimum checks:

```text
npx -y pnpm@10.0.0 typecheck
npx -y pnpm@10.0.0 test apps/api/src/http/app.legacy-cleanup.test.ts apps/api/src/local/local-file-service.test.ts apps/api/src/services/live-writer.test.ts
npx -y pnpm@10.0.0 test apps/cli/marklab-cli.test.mjs apps/cli/agent-instructions.test.mjs
npx -y pnpm@10.0.0 --filter @marklab/web exec playwright test tests/no-legacy-cloud-ui.spec.ts tests/local-file-sync.spec.ts tests/relay-collaboration.spec.ts
rg -n "/api/docs/.*/(write|edit)|marklab (write|edit|hosted-write|hosted-edit)|read_doc|write_doc|edit_doc|agent token|branch switcher|cloud document dashboard" README.md docs/product docs/agent apps/web/src apps/cli apps/api/src && exit 1 || true
rg -n "(should|must|can) (call|use).*hosted.*(write|edit)|hosted.*(write|edit).*as the product path" README.md docs/product docs/agent && exit 1 || true
for f in 0*.md; do head -20 "$f" | rg -q "Historical cloud-first reference|Superseded by.*local-first" || exit 1; done
git diff --check
```

Manual acceptance:

```text
1. Start marklab open README.md.
2. Confirm no New, Import, Branch, Admin token, or hosted AI token UI appears.
3. Confirm Versions still works for local snapshots.
4. Confirm Share uses relay links, not cloud branch links.
5. Try a legacy hosted AI write route and confirm it is unavailable.
6. Try marklab write README.md and confirm the CLI rejects it.
7. Edit README.md through a normal local file edit and confirm MarkLab syncs it.
```
