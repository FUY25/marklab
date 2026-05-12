# Collab Web App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `apps/collab-web`, the formal browser collaborator entry point for edit and view links.

**Architecture:** The browser editor connects to the control plane for session creation and to the Y-Sweet provider only for edit-capable sessions. Edit mode binds CodeMirror 6 to `Y.Text("contents")` and renders awareness cursors/highlights; view mode fetches current Markdown/rendered state and never receives provider credentials.

**Tech Stack:** Vite, React, TypeScript, CodeMirror 6, Yjs, y-indexeddb, Y-Sweet provider client, Vitest, Playwright.

## Reference Implementations (MIT — OK to copy)

**This plan has the highest code-reuse leverage of any plan.** Relay's entire `y-codemirror.next/` directory is a production-tested CodeMirror+Yjs+awareness integration that maps almost 1:1 onto what this plan needs. Copy the relevant files into MarkLab-owned packages (probably `packages/collab-editor/` so the native app can share them in Plan 4); do not re-derive.

**Rules of reuse:**

1. **Default to copying, not re-deriving.** This plan especially: Relay's `y-codemirror.next/` directory took real engineering effort to debug. Lift those files into `packages/collab-editor/` (so Plan 4's native app can share them) and adapt — do not re-derive remote-cursor rendering or CodeMirror+Y.Text binding from scratch. The reference table below is your "already-done" inventory.
2. **`Learning resources/` is read-only as a directory.** Never edit, move, delete, or `git add` anything under it. Read freely; paste into MarkLab-owned files.
3. **Preserve attribution.** Copy `Learning resources/Relay/src/y-codemirror.next/LICENSE` as a comment header into each MarkLab file that adopts code from this directory. `Learning resources/Relay/src/client/types.ts` is a worked example of the attribution-comment style.
4. **Strip Obsidian-specific calls** (`Vault`, `TFile`, `MarkdownView`, `getPatcher()`, plugin lifecycle hooks) and replace with browser DOM / React equivalents.

| This plan's task | Lift from | What to copy |
|---|---|---|
| Task 2 (collab session API client) | `Learning resources/y-sweet/js-pkg/sdk/` and `Learning resources/y-sweet/js-pkg/react/` | The `ClientToken` parsing (already in Plan 1A's `apps/api`) and React provider hooks. The hooks pattern is directly liftable. |
| Task 2 (token refresh client) | `Learning resources/Relay/src/TokenStore.ts:55-248` + `Learning resources/Relay/src/LiveTokenStore.ts:21-103` | The same refresh-queue logic Plan 1A used server-side, ported to fetch against MarkLab's `/api/.../provider-token/refresh` from the browser. |
| Task 3 (CodeMirror ↔ Y.Text binding) | `Learning resources/Relay/src/y-codemirror.next/LiveEditPlugin.ts` | The main CodeMirror plugin — Y.Text observer wiring, transaction origin handling, undo manager integration. Drop the Obsidian-specific banner code (lift it separately in Plan 5). |
| Task 3 (Y.Text-to-CodeMirror DOM bridge) | `Learning resources/Relay/src/y-codemirror.next/LiveNodePlugin.ts` | DOM-level plugin for live-rendered nodes. Optional in v1 source-only MVP; useful when you add decorations. |
| Task 3 (offset ↔ relative position) | `Learning resources/Relay/src/y-codemirror.next/PositionTransformer.ts` and `Learning resources/Relay/src/y-codemirror.next/YRange.ts` | Conversion between absolute CodeMirror offsets and Yjs relative positions. Copy verbatim — this is exactly what the spec's cursor-and-highlight section requires. |
| Task 4 (remote cursor rendering) | `Learning resources/Relay/src/y-codemirror.next/RemoteSelections.ts` | THE remote-cursor/selection decoration extension for CodeMirror. Copy the full file; adapt the color/name source to read from MarkLab's awareness shape. |
| Task 4 (presence avatars + indicators) | `Learning resources/Relay/src/AwarenessViewPlugin.ts` + `Learning resources/Relay/src/User.ts` | Awareness-state subscribing pattern and user-color generator. Replace Obsidian status-bar code with a React presence-avatar component. |
| Task 5 (read-only Markdown view) | `Learning resources/collabmd/` | Layout/CSS for a read-only Markdown page. Lift styles and shell; do not adopt collabmd's sync code. |
| Task 6 (E2E test harness) | `Learning resources/y-sweet/tests/` | Test patterns for Y-Sweet client connections. |
| Task 7 (workspace settings shell, from Plan 2 Task 7B) | `Learning resources/collabmd/` | Page chrome / tabs layout. Skip if not building Members/Documents tabs in this plan. |

---

## Scope

This plan starts after Plan 1B makes provider runtime and health real and after the Control Plane MVP has locked the real session/grant/token-refresh contract. It does not build MarkLab.app native integration or billing UI.

`apps/collab-web` is the single browser surface for MarkLab. This plan ships the single-document editing/view shell. `2026-05-11-control-plane-mvp.md` Task 7B extends `apps/collab-web` with a workspace settings page (Members/Documents tabs in v1); `2026-05-11-billing-subscription-seats.md` adds a Plan & Billing tab to that settings page. Both downstream plans assume this app exists, so this plan must not change its name or top-level route shape after landing.

## Provider Runtime Facts From Plan 1B

- The alpha provider is an API-supervised upstream Y-Sweet 0.9.1 child process in the same Fly machine as the API.
- Edit `ClientToken`s returned by the control plane contain the provider document id and public Y-Sweet URLs. The browser should use the token through `@y-sweet/client`; do not construct provider websocket URLs from a separate env var.
- Public provider routes are root-mounted on the API host in process mode: `/d/<providerDocId>/ws/<providerDocId>`, `/d/<providerDocId>/as-update`, and `/d/<providerDocId>/update`.
- View mode still receives no provider token and must make no provider websocket or document HTTP requests.

## Deferred Browser Wiring From Plan 2

Before starting implementation, carry forward the browser items explicitly deferred from `2026-05-11-control-plane-mvp.md` because `apps/collab-web` did not exist during Plan 2:

- Joining links must carry the server-issued login or guest session state; do not fall back to anonymous edit in public mode.
- Edit sessions must persist the returned `session.refreshToken`, refresh provider tokens through `POST /api/docs/:docId/branches/:branchId/collab/session/:sessionId/provider-token/refresh`, and stop editing when refresh is denied. The refresh request sends only the session refresh token; it must not require the raw share token again.
- The browser UI must surface seat, guest quota, expiry, revocation, role downgrade, and provider-token-revoked failures from the control-plane contract.
- Plan 2 delivered the server APIs for `/workspaces/:workspaceId/settings`: member list, workspace share-key invite, member role change, member removal, and workspace document list with active view/edit grant counts. This plan should implement the Members and Documents tabs when doing so does not weaken the single-document editor/view acceptance gates. Plan & Billing remains in `2026-05-11-billing-subscription-seats.md`; Folders remain future work.
- Document creation/import now accepts `workspaceId` on `POST /api/docs` and `POST /api/docs/import`. When present, the API requires a logged-in workspace `Owner` or `Member`, writes `documents.owner_id` and `documents.workspace_id`, and lists the document through `/api/workspaces/:workspaceId/documents`.
- Production mode must not use `/api/auth/dev-login`: `NODE_ENV=production` disables dev login even if `MARKLAB_ENABLE_DEV_AUTH=true`. Browser tests that need dev auth must run outside production mode.

## File Structure

- Create `apps/collab-web/package.json`
- Create `apps/collab-web/index.html`
- Create `apps/collab-web/src/main.tsx`
- Create `apps/collab-web/src/App.tsx`
- Create `apps/collab-web/src/api/collab-session.ts`
- Create `apps/collab-web/src/editor/CollaborativeMarkdownEditor.tsx`
- Create `apps/collab-web/src/editor/ReadOnlyMarkdownView.tsx`
- Create `apps/collab-web/src/presence/awareness.ts`
- Create `apps/collab-web/src/presence/remote-cursors.ts`
- Create `apps/collab-web/src/workspaces/WorkspaceSettings.tsx` if implementing the Members/Documents settings shell in this plan.
- Create `apps/collab-web/src/styles.css`
- Modify `pnpm-workspace.yaml` only if the current workspace glob does not already include `apps/*`.
- Modify `infra/docker/api.Dockerfile` or create a dedicated collab-web build path after deploy shape is confirmed.
- Modify downstream plan files listed in the final task.

## Tasks

### Task 1: App Scaffold

- [ ] Create the Vite React TypeScript app under `apps/collab-web`.
- [ ] Add scripts: `dev`, `build`, `typecheck`, `test`.
- [ ] Add env vars:
  - `VITE_MARKLAB_API_URL`
  - Do **not** add a separate provider websocket env var for process mode; the Y-Sweet `ClientToken` carries the public provider base URL.
- [ ] Acceptance command: `npx -y pnpm@10.0.0 --filter @marklab/collab-web typecheck`.

### Task 2: Collab Session API Client

- [ ] Implement `apps/collab-web/src/api/collab-session.ts`.
- [ ] It calls `POST /api/docs/:docId/branches/:branchId/collab/session`.
- [ ] It refreshes edit provider tokens through the control-plane token-refresh endpoint before the configured refresh margin (default 2 minutes; sourced from a shared `provider-token-policy` module mirroring `apps/api/src/config/provider-token-policy.ts`, not a magic number).
- [ ] It stores the edit session refresh token separately from the Y-Sweet `ClientToken` and sends `{ refreshToken }` on refresh.
- [ ] It parses `mode=view` responses without provider token.
- [ ] It parses `mode=edit` responses with provider token.
- [ ] Add Vitest tests for both response shapes.
- [ ] Acceptance command: `npx -y pnpm@10.0.0 --filter @marklab/collab-web test`.

### Task 3: Edit Mode CodeMirror + Y.Text

- [ ] Implement `CollaborativeMarkdownEditor.tsx`.
- [ ] Create one Y.Doc per provider doc id.
- [ ] Bind CodeMirror document text to `ydoc.getText("contents")`.
- [ ] Store edit-session Yjs state in IndexedDB with a key that includes provider doc id and session id.
- [ ] Show connection states: connecting, connected, reconnecting, offline, unavailable.
- [ ] Deny local edits and surface an unavailable state if provider-token refresh is rejected after revocation.
- [ ] Acceptance: two browser tabs connected to the same edit link converge on the same Markdown text.

### Task 4: Presence, Cursor, Highlight

- [ ] Implement awareness schema matching `docs/appdesigndoc.md`.
- [ ] Publish user display name, color, session kind, and source-editor cursor selection.
- [ ] Render remote cursors and remote selection highlights in source panes.
- [ ] In preview-only mode, show non-positional presence indicators instead of attempting caret placement.
- [ ] Acceptance: two browser tabs show each other's cursor/highlight while editing the same source pane.

### Task 5: View Mode

- [ ] Implement `ReadOnlyMarkdownView.tsx`.
- [ ] Fetch current snapshot via control plane session route.
- [ ] Render selectable/copyable Markdown content.
- [ ] Do not mount CodeMirror as an editor.
- [ ] Do not create Y.Doc, Y-Sweet provider, awareness provider, or IndexedDB Yjs persistence.
- [ ] Read-only routes must not create durable version rows; do not assume `read` or `export.md` checkpoints the document for view grants.
- [ ] Add a test that view mode never calls the provider connection factory.
- [ ] Acceptance: view link opens a rendered document and browser devtools network has no provider websocket.

### Task 6: Playwright E2E

- [ ] Add browser E2E tests for:
  - edit tab A to edit tab B sync;
  - cursor/highlight visibility;
  - offline/reconnect indicator;
  - view mode no provider websocket;
  - revoked view/edit session surfaces unavailable state.
- [ ] Acceptance command: `npx -y pnpm@10.0.0 --filter @marklab/collab-web test:e2e`.

### Task 7: Build And Deploy Wiring

- [ ] Decide whether collab-web is served by the API process or as a separate static app.
- [ ] Update Docker/Fly config according to that decision.
- [ ] Ensure `MARKLAB_PUBLIC_WEB_URL` points to the browser collaborator route that real share links open.
- [ ] Acceptance command: production build serves the collab-web entry and does not break existing `apps/web` routes.

### Task 7B: Workspace Settings Shell

- [ ] Add `/workspaces/:workspaceId/settings`.
- [ ] Add a Members tab backed by `GET /api/workspaces/:workspaceId/members`, `POST /api/workspaces/:workspaceId/share-keys`, `PATCH /api/workspaces/:workspaceId/members/:userId`, and `DELETE /api/workspaces/:workspaceId/members/:userId`.
- [ ] Add a Documents tab backed by `GET /api/workspaces/:workspaceId/documents`.
- [ ] Enforce Owner-only sensitive actions server-side; the UI may hide controls for non-owners but must surface server `403` responses correctly.
- [ ] Do not add Plan & Billing or Folders tabs here beyond disabled placeholders; those belong to downstream plans.
- [ ] Acceptance: Owner can list members, create a share key, change/remove a member, and inspect workspace document grant counts from the browser shell; Reader can inspect read-only state but cannot mutate settings.

### Task 8: Verification

- [ ] Run `npx -y pnpm@10.0.0 --filter @marklab/collab-web test`.
- [ ] Run `npx -y pnpm@10.0.0 --filter @marklab/collab-web typecheck`.
- [ ] Run browser E2E smoke.
- [ ] Run `git diff --check`.
- [ ] Commit with `git commit -m "feat: add collab web app"`.

### Task 9: Downstream Plan Refresh

- [ ] Review implemented browser env vars, session response shapes, provider connection factory, and E2E results.
- [ ] Update `docs/appdesigndoc.md` if browser mode, view mode, or cursor/highlight behavior changed.
- [ ] Update these downstream plans:
  - `docs/plans/2026-05-11-marklab-native-integration.md`
  - `docs/plans/2026-05-11-reconnect-conflict-hardening.md`
  - `docs/plans/2026-05-11-packaging-cli-distribution-docs.md`
  - `docs/plans/2026-05-11-billing-subscription-seats.md`
  - `docs/plans/2026-05-11-production-deploy-alpha-launch.md`
- [ ] Run `rg -n "apps/collab-web|view mode|provider websocket|cursor|highlight|IndexedDB" docs/plans docs/appdesigndoc.md`.
- [ ] Commit plan refresh with `git commit -m "docs: refresh plans after collab web"`.
