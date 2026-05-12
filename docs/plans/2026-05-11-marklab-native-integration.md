# MarkLab Native Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the MarkLab.app native/local editor surface based on MarkEdit behavior and connect it to the same single-file collaboration model as browser collaborators.

**Architecture:** MarkLab.app is the first-class local-file entry point. It opens a user-owned `.md` file, binds native CodeMirror/MarkEdit editing to `Y.Text("contents")` for shared files, projects provider changes back to disk, ingests local file watcher changes, and exposes share/manage actions through app UI and CLI.

**Tech Stack:** MarkEdit reference code, macOS native app stack selected during implementation, CodeMirror, Yjs, local file watcher, existing `apps/api` local daemon, existing `apps/cli`.

## Reference Implementations (MIT — OK to copy)

Two MIT-licensed sources dominate this plan: **MarkEdit** for the macOS app shell / editor / file I/O, and **Relay's `y-codemirror.next/`** for the collaboration bindings. The **Port** strategy in Task 1 explicitly allows copying MarkEdit source into `apps/marklab-macos/`.

**Rules of reuse:**

1. **Default to copying, not re-deriving.** This plan has the most code to lift of any plan: MarkEdit gives you a working macOS Markdown editor, Relay gives you the collaboration bindings. Re-authoring either from scratch is the wrong cost trade. Port MarkEdit's macOS shell into `apps/marklab-macos/`, lift Relay's `y-codemirror.next/` into a shared `packages/collab-editor/`, and spend your engineering time on the MarkLab-specific integration glue.
2. **`Learning resources/` is read-only as a directory.** Never edit, move, delete, or `git add` anything under it. Read freely; paste into `apps/marklab-macos/` with attribution headers.
3. **Preserve attribution.** Each adopted MarkEdit file keeps the upstream MIT LICENSE / copyright header. Add a one-line note: `// Adapted from MarkEdit <upstream-commit-sha>, MIT licensed.`
4. Adapt to MarkLab branding (app name, bundle id, icons, default settings) and to MarkLab's collaboration model (Y.Text + provider tokens) — MarkEdit is single-user, so collaboration code comes from Relay's `y-codemirror.next/`.

| This plan's task | Lift from | What to copy |
|---|---|---|
| Task 1 (Port strategy) | `Learning resources/MarkEdit/` (entire repo) | If choosing **Port**: copy the macOS app target structure (`Xcode project`, `Info.plist`, Swift/SwiftUI sources, CodeMirror bundle build setup, `entitlements`) into `apps/marklab-macos/`. If choosing **Reference**: read the same files but rewrite from scratch. |
| Task 2 (local file open/save) | `Learning resources/MarkEdit/` (NSDocument / file open/save behavior) | The exact AppKit `NSDocument` subclass wiring and `presentedItemDidChange` / `reloadFromContents` hooks for file watching. Lift directly. |
| Task 2 (CodeMirror native bundle) | `Learning resources/MarkEdit/` build scripts that bundle CodeMirror for WKWebView | The esbuild/rollup setup that produces the in-app CodeMirror bundle. |
| Task 4 (native CodeMirror ↔ Y.Text) | `Learning resources/Relay/src/y-codemirror.next/LiveEditPlugin.ts` (same file Plan 3 lifts) | Same plugin reused inside MarkLab.app's WKWebView. Extract MarkLab's reimplementation to `packages/collab-editor/` so the browser and native apps share one source. |
| Task 4 (offset/range mapping) | `Learning resources/Relay/src/y-codemirror.next/PositionTransformer.ts` and `YRange.ts` | Same as Plan 3. Share via the same package. |
| Task 5 (native remote cursor) | `Learning resources/Relay/src/y-codemirror.next/RemoteSelections.ts` | Same as Plan 3. Native and browser render the same cursor decorations from the same awareness state. |
| Task 5 (presence color/name) | `Learning resources/Relay/src/User.ts` | Color generator. Lift once into shared package. |
| Task 6 (CLI/app boundary) | (no learning-resource reference; MarkLab-original IPC) | — |

---

## Scope

This plan starts after the control-plane session/grant/token-refresh contract exists and after the browser app has proven provider connection, session, cursor, and view behavior. It does not add folder collaboration or rich/WYSIWYG editing.

## Provider Runtime Facts From Plan 1B

- Native edit sessions consume the same Y-Sweet `ClientToken` shape as browser edit sessions. The token contains the provider doc id and public provider URLs; native code should not hardcode provider websocket paths or read a separate provider websocket env var.
- In API-supervised process mode, public provider traffic is root-mounted on the API host and proxied to the child provider only for document routes: `/d/<providerDocId>/ws/<providerDocId>`, `/d/<providerDocId>/as-update`, and `/d/<providerDocId>/update`.
- Provider durability for alpha is the child Y-Sweet store on `/data/ysweet` in Fly and `.marklab-provider-data/ysweet` locally; native/local persistence is still responsible only for offline client state and disk projection, not provider checkpoint storage.

## Control Plane Facts From Plan 2

- Public hosted mode is login-backed. Dev anonymous and dev login are internal-only; `NODE_ENV=production` disables `/api/auth/dev-login` even when the env flag is set.
- Document create/import accepts `workspaceId` on `POST /api/docs` and `POST /api/docs/import`. Native share/start-sharing must create or select a workspace first, then create the document as a logged-in `Owner` or `Member`; do not create admin-only orphan documents.
- Workspace APIs already exist for membership/share-key/settings data: `/api/workspaces`, `/api/workspaces/:workspaceId/members`, `/api/workspaces/:workspaceId/share-keys`, `/api/workspaces/join`, and `/api/workspaces/:workspaceId/documents`.
- Edit sessions return a control-plane session refresh token alongside the Y-Sweet `ClientToken`. Native code must persist the session refresh token securely enough for alpha, refresh through the control-plane endpoint, and stop editing when refresh is denied for revocation, expiry, role downgrade, or provider-token revocation.
- View links receive control-plane snapshots only and no provider token. Native code must not try to join the provider for view-only links.

## File Structure

- Create `apps/marklab-macos/` or equivalent native app folder after confirming the MarkEdit import strategy.
- Modify `apps/api/src/local/local-file-service.ts`
- Modify `apps/api/src/local/local-file-service.test.ts`
- Modify `apps/api/src/routes/local-file-routes.ts`
- Modify `apps/api/src/routes/local-conflict-routes.ts`
- Modify `apps/cli/marklab.mjs`
- Modify `apps/cli/marklab-cli.test.mjs`
- Modify `docs/product/marklab-alpha-user-guide.md`
- Modify downstream plan files listed in the final task.

## Tasks

### Task 1: MarkEdit Import Strategy

- [ ] Inspect `Learning resources/MarkEdit` for license, app structure, editor integration, file open/save behavior, and CodeMirror usage.
- [ ] Choose one of two in-repo strategies:
  - **Port:** create `apps/marklab-macos` and port the needed editor/file behavior from MarkEdit into this monorepo.
  - **Reference:** keep MarkEdit as external reference and implement a new native app shell under `apps/marklab-macos` without lifting source.
- [ ] Forking MarkEdit into a separate repository is **not** an allowed v1 option. `2026-05-11-packaging-cli-distribution-docs.md` packages the native app from this repo and does not coordinate with an external native repo. If a future plan introduces a separate native repo, packaging must be redesigned at the same time.
- [ ] Record the chosen strategy in `docs/appdesigndoc.md`.
- [ ] Acceptance: `apps/marklab-macos/` exists in this monorepo with a documented MarkEdit import or independent-shell decision. Packaging (`2026-05-11-packaging-cli-distribution-docs.md`) can locate the native source from this repo without external coordination.

### Task 2: Local File Open And Save

- [ ] Implement native file open for one `.md` file.
- [ ] Reuse or call existing local daemon APIs for summary, versions, restore, and conflict status.
- [ ] Preserve normal local editing when a file is not shared.
- [ ] Acceptance: opening, editing, saving, closing, and reopening a file preserves exact Markdown bytes except intentional LF normalization for shared files.

### Task 3: Share And Manage UI

- [ ] Add app actions for:
  - start sharing;
  - create edit link;
  - create view link;
  - revoke link;
  - show share state;
  - copy browser link.
- [ ] On first share, require login, create/select a workspace, and pass `workspaceId` to the document create/import route so the shared document is workspace-owned and appears in workspace document lists.
- [ ] Connect these actions to local daemon/control-plane APIs rather than directly mutating provider state.
- [ ] Acceptance: a user can create an edit link from MarkLab.app and join it from `apps/collab-web`.

### Task 4: Native Collaboration Editing

- [ ] Bind the native editor to the same `Y.Text("contents")` model as browser edit mode.
- [ ] Project remote provider changes to disk using the Plan 1A baseline path.
- [ ] Ingest local disk changes using the Plan 1A baseline path.
- [ ] Show connection states in app chrome.
- [ ] Acceptance: native app and browser edit session converge on the same Markdown text.

### Task 5: Native Presence, Cursor, Highlight

- [ ] Publish native cursor/selection awareness using Yjs relative positions.
- [ ] Render browser collaborator cursor/highlight in native source editor.
- [ ] Render native collaborator cursor/highlight in browser source editor.
- [ ] Acceptance: native app and browser show each other's cursor/highlight while editing.

### Task 6: CLI/App Boundary

- [ ] Ensure `marklab share`, `create-link`, `revoke-link`, `status`, `wait`, `conflict`, and `export` can operate when the native app is running.
- [ ] Ensure the CLI can start or find the local daemon without stealing focus from the native app.
- [ ] Ensure native edit sessions refresh provider tokens through the same control-plane endpoint as browser edit sessions.
- [ ] Persist and use the control-plane session refresh token returned by the edit-session route; do not attempt refresh with the original share token or with provider token internals.
- [ ] Use the `ClientToken` returned by the control plane as the source of provider connection URLs; do not duplicate `MARKLAB_YSWEET_PUBLIC_URL_PREFIX` or provider route construction in native code.
- [ ] Acceptance command: `node apps/cli/marklab.mjs share README.md --json` returns a usable link while the app owns the file.

### Task 7: Native E2E Smoke

- [ ] Add same-Mac smoke script for:
  - native host opens a file;
  - browser guest joins edit link;
  - browser edits;
  - native sees update;
  - disk receives projected Markdown;
  - native edits;
  - browser sees update.
- [ ] Acceptance: the smoke passes with one local machine and no VM.

### Task 8: Verification

- [ ] Run native build/test command selected by the MarkEdit strategy.
- [ ] Run `npx -y pnpm@10.0.0 test apps/api/src/local apps/cli`.
- [ ] Run native/browser E2E smoke.
- [ ] Run `git diff --check`.
- [ ] Commit with `git commit -m "feat: integrate marklab native collaboration"`.

### Task 9: Downstream Plan Refresh

- [ ] Review native app folder, daemon boundary, local file behavior, share UI, and same-Mac smoke results.
- [ ] Update `docs/appdesigndoc.md` if the native app strategy or local edit behavior changed.
- [ ] Update these downstream plans:
  - `docs/plans/2026-05-11-control-plane-mvp.md`
  - `docs/plans/2026-05-11-reconnect-conflict-hardening.md`
  - `docs/plans/2026-05-11-packaging-cli-distribution-docs.md`
  - `docs/plans/2026-05-11-billing-subscription-seats.md`
  - `docs/plans/2026-05-11-production-deploy-alpha-launch.md`
- [ ] Run `rg -n "MarkEdit|native|daemon|local file|share UI|cursor|highlight" docs/plans docs/appdesigndoc.md`.
- [ ] Commit plan refresh with `git commit -m "docs: refresh plans after native integration"`.
