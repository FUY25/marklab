# Collab Web App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `apps/collab-web`, the formal browser collaborator entry point for edit and view links.

**Architecture:** The browser editor connects to the control plane for session creation and to the Y-Sweet provider only for edit-capable sessions. Edit mode binds CodeMirror 6 to `Y.Text("contents")` and renders awareness cursors/highlights; view mode fetches current Markdown/rendered state and never receives provider credentials.

**Tech Stack:** Vite, React, TypeScript, CodeMirror 6, Yjs, y-indexeddb, Y-Sweet provider client, Vitest, Playwright.

---

## Scope

This plan starts after Plan 1B makes provider runtime and health real and after the Control Plane MVP has locked the real session/grant/token-refresh contract. It does not build MarkLab.app native integration or billing UI.

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
  - `VITE_MARKLAB_PROVIDER_WS_URL`
- [ ] Acceptance command: `npx -y pnpm@10.0.0 --filter @marklab/collab-web typecheck`.

### Task 2: Collab Session API Client

- [ ] Implement `apps/collab-web/src/api/collab-session.ts`.
- [ ] It calls `POST /api/docs/:docId/branches/:branchId/collab/session`.
- [ ] It refreshes edit provider tokens through the control-plane token-refresh endpoint before the 2-minute refresh margin.
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
  - `docs/superpowers/plans/2026-05-11-marklab-native-integration.md`
  - `docs/superpowers/plans/2026-05-11-reconnect-conflict-hardening.md`
  - `docs/superpowers/plans/2026-05-11-packaging-cli-distribution-docs.md`
  - `docs/superpowers/plans/2026-05-11-billing-subscription-seats.md`
  - `docs/superpowers/plans/2026-05-11-production-deploy-alpha-launch.md`
- [ ] Run `rg -n "apps/collab-web|view mode|provider websocket|cursor|highlight|IndexedDB" docs/superpowers/plans docs/appdesigndoc.md`.
- [ ] Commit plan refresh with `git commit -m "docs: refresh plans after collab web"`.
