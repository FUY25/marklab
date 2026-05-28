# Packaging CLI Distribution Docs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package MarkLab so alpha users and AI agents can install it, share local files, join the same edit links in browser or MarkLab.app, diagnose failures, and follow clear docs without reading source code.

**Architecture:** CLI and native app are the local control surface; hosted provider/control plane are defaults for normal users. The CLI controls software actions and never becomes a hosted content write API.

**Tech Stack:** Existing `apps/cli`, Node packaging, macOS app packaging path selected in `2026-05-11-marklab-native-integration.md`, docs under `docs/product` and `docs/production`, Vitest/Node tests.

## Reference Implementations (MIT — OK to copy)

This plan is mostly MarkLab-original packaging and CLI work. The one reference of value is MarkEdit's MIT-licensed macOS release pipeline (notarization, signing, DMG building) if the native plan chose the **Port** strategy.

**Rules of reuse:**

1. **Default to copying, not re-deriving.** macOS notarization and signing has a lot of fiddly steps. If MarkEdit's release scripts already encode them, copy and adapt — do not re-derive the notarization workflow from Apple docs.
2. **`Learning resources/` is read-only as a directory.** Never edit, move, delete, or `git add` anything under it. Read freely; paste into MarkLab-owned files.
3. **Preserve attribution.** Copy the upstream LICENSE/copyright header into each adopted file.

| This plan's task | Lift from | What to copy |
|---|---|---|
| Task 4 (native packaging) | `Learning resources/MarkEdit/` release/CI scripts | macOS notarization workflow, code-signing setup, DMG packaging scripts. Lift verbatim, adapt bundle id / signing identity. |
| Task 2/Task 3 (CLI surface, agent docs) | (no learning-resource reference) | Original MarkLab work. |

---

## Scope

This plan does not build billing or the full production launch gate. It does include a Fly.io + Neon pilot connection target for packaged-client smoke testing, because app-to-app collaboration across machines needs a hosted control plane/provider. Production deploy hardening, rollback, launch observability, and final operator runbooks stay in `2026-05-11-production-deploy-alpha-launch.md`.

## Provider Runtime Facts From Plan 1B

- Packaged hosted defaults should point users at the hosted API/web origin. Edit clients receive provider URLs from Y-Sweet `ClientToken`s; the CLI should not expose or require a separate provider websocket URL for normal users.
- Packaged pilot builds must support two non-legacy runtime targets: local dev (`127.0.0.1` API/provider) and hosted staging/alpha (Fly.io API/web backed by Neon Postgres). Switching targets must be explicit in config/doctor output so a user can tell whether they are testing local or hosted relay.
- The hosted API supervises the upstream Y-Sweet child process and proxies public provider document routes at the API root. `marklab doctor --json` should report provider readiness from `/healthz.provider`, not by probing the child provider port directly.
- Troubleshooting docs should mention `provider.ready`, `provider.storeReady`, provider schema readiness, and the root-mounted `/d/<providerDocId>/...` route shape when diagnosing provider failures.

## Control Plane Facts From Plan 2

- Public hosted mode is login-backed. Packaged CLI/native flows must obtain or reuse a user session; they must not rely on `MARKLAB_ENABLE_DEV_AUTH`, `MARKLAB_ENABLE_DEV_ANONYMOUS_COLLAB`, or admin-token-only document creation in production.
- `POST /api/docs` and `POST /api/docs/import` accept `workspaceId` for workspace-owned documents. `marklab share` should create/select a workspace, pass `workspaceId`, and avoid creating orphan admin documents.
- Workspace APIs exist for alpha docs and troubleshooting: `/api/workspaces`, `/api/workspaces/:workspaceId/members`, `/api/workspaces/:workspaceId/share-keys`, `/api/workspaces/join`, and `/api/workspaces/:workspaceId/documents`.
- Provider token refresh uses a control-plane session refresh token returned by the edit-session route. CLI docs should distinguish that refresh token from raw share tokens and Y-Sweet `ClientToken`s.
- Revoked/expired links and provider-token revocation surface as explicit API errors; troubleshooting docs should name `grant_revoked`, `grant_expired`, `provider_token_revoked`, and `collab_session_not_found`.

## Browser Facts From Plan 3

- `apps/collab-web` is built into the API Docker image and served by the API process. The deploy-time dist path is `MARKLAB_COLLAB_WEB_DIST_DIR`; normal packaged clients should not need a separate collab-web origin.
- Browser collaborator links should open the public web origin at `/collab?docId=...&branchId=...&token=...&mode=edit|view`. The active browser surface is `apps/collab-web`, with assets under `/collab-web/`; the archived `apps/web` surface has been removed.
- `/workspaces/:workspaceId/settings` exists in `apps/collab-web` with Members, Documents, and read-only Plan & Billing tabs. Packaging/docs should route workspace administration to that browser shell until native settings UI exists.

## Native Facts From Plans 4 And 5.5

- Native source is `apps/marklab-macos/`, a SwiftPM package using a Port MarkEdit UI shell strategy. Package from this repo; do not assume a separate native repository.
- The native app now uses a MarkEdit-derived document shell, bundled CodeMirror-in-WebKit local Markdown editor surface, toolbar/status/inspector collaboration layer, and document-scoped conflict panel. Packaging smoke must open the packaged app into that shell; a generic SwiftUI prototype form is no longer the expected UI.
- The native app embeds the hosted `/collab` editor in a WKWebView for shared editing. Later packaging may bundle a richer/native Yjs runtime, but alpha packaging must include the hosted-collab bridge behavior and its same-origin API authorization injection.
- The published CLI is now a slim native-app bridge plus hosted `/collab` helper. Package smokes must verify the shipped tarball includes the CLI entrypoints, agent instruction templates, `doctor`, `share --edit|--view`, and `join`, without relying on removed local-daemon runtime bundles.
- The legacy local daemon boundary and local app-context routes have been removed from the active package. Packaging must not document or test a daemon opt-in path or mint hidden local relay grants to bootstrap app local state.
- The old `marklab` CLI local-daemon commands have been removed from the active package. Historical compatibility commands belong in archived docs only; the current package should route share/join through MarkLab.app and hosted control-plane state.
- Native app/browser smoke command is `npx -y pnpm@10.0.0 --filter @marklab/marklab-macos smoke:native-browser`. The passing smoke returns shell/runtime gates, app-kind/browser convergence, disk projection, and bidirectional cursor-awareness gates. It does not prove a signed `.app` bundle, notarization, or GUI WKWebView automation; Task 4 and Task 6 must add those packaging-specific checks.
- True app-to-app/local-to-local collaboration is not proven by app-browser smoke. It requires a native join/open-shared-document flow: the same edit link that opens `/collab?...mode=edit` in a browser must be accepted by MarkLab.app, bound to a user-selected local `.md` file, persisted, and reopened without the legacy local daemon.
- Agents do not appear as collaborators. Agent edits happen by editing the local `.md`; the active MarkLab.app session ingests those disk changes into the shared document.

## File Structure

- Modify `apps/cli/marklab.mjs`
- Modify `apps/cli/doctor.mjs`
- Modify `apps/cli/*.test.mjs`
- Modify native packaging files from `2026-05-11-marklab-native-integration.md`.
- Modify native share/join UI in `apps/marklab-macos/Sources/MarkLabApp/MarkEditShell/`.
- Modify native app model/link persistence in `apps/marklab-macos/Sources/MarkLabApp/MarkLabApp.swift` or a new focused native persistence module.
- Modify native URL/deep-link handling files if the package registers a `marklab://` join/open URL scheme.
- Modify `README.md`
- Modify `docs/product/marklab-alpha-user-guide.md`
- Modify `docs/Archive/local-daemon-distribution.md`
- Modify `docs/agent/marklab-agent-guide.md`
- Modify downstream plan files listed in the final task.

## Tasks

### Task 1: Hosted Defaults

- [x] Ensure packaged CLI defaults to hosted alpha API/provider URLs for archived relay compatibility.
- [x] Ensure local dev can override URLs with env vars for archived relay compatibility.
- [x] Replace archived daemon `doctor` with a new relay/native doctor that reports native app/open-link configuration, API/web origin, `/healthz.provider.ready`, `/healthz.provider.storeReady`, and `/healthz.schema.ready`.
- [x] Acceptance command: new `marklab doctor --json` shows hosted/default/local override state without requiring any archived daemon flag.

### Task 2: CLI Command Coverage

V1 (alpha launch must-have):

- [x] `join` — open the same `/collab?...mode=edit` share link in MarkLab.app without enabling the archived daemon path.
- [x] `stop` — report that the archived daemon stop surface is removed; it must not imply that the new hosted path requires a daemon.
- [x] `open` — open a local Markdown file in MarkLab.app or a sensible default without the archived daemon path.
- [x] `share` — open the local file in MarkLab.app and route the user to native Start Sharing, not an archived local-daemon relay link.
- [x] `status` — show current native relay sync/conflict state for a file.
- [x] `wait --synced` — block until native relay sync is complete; used by agents.
- [x] `conflict` — read current native relay conflict state as JSON for agents.
- [x] `doctor` — diagnose install, URLs, app URL scheme, and provider readiness without requiring daemon opt-in.

Post-alpha (ship if scope permits, otherwise tag as `coming-soon` in help text):

- [ ] `create-link` — create a new view/edit link without opening UI.
- [ ] `revoke-link` — revoke a link by id.
- [ ] `share-state` — show all current share grants for a file.
- [ ] `save-version` — snapshot the current shared state as a named version.
- [ ] `versions` — list known versions of a shared document.

The CLI is not the home for the agent edit `begin/end` protocol described in the spec; that protocol stays out of v1 (see Task 3).

- [x] Add tests proving `join` preserves `/collab?...` edit URLs and does not rewrite them back to legacy hosted relay routes.
- [x] Add tests proving `join` never falls back to the archived local-daemon route.
- [x] Add tests for new native relay `open/share/status/wait/conflict/doctor` once those commands are rebound.
- [x] Prove the native app, not the CLI, creates/imports the document into a workspace with `workspaceId` and does not require admin-only auth in hosted mode (`NativeControlPlaneShareTests`).
- [x] Acceptance command: `npx -y pnpm@10.0.0 test apps/cli` covers the current join/deactivation slice.

### Task 3: AI Agent Workflow

- [x] Update `docs/agent/marklab-agent-guide.md`.
- [x] Document that AI edits local `.md` files directly. The active MarkLab.app file watcher ingests changes into shared state automatically when a file is part of an active room; AI does not need a special API.
- [x] Document that `wait --synced`, `status`, and `conflict` read the new native relay session model through MarkLab.app support files.
- [x] Document the **deferred** explicit agent edit protocol (`marklab agent edit begin/end`) as post-v1 by omission from the shipped pilot flow: v1 relies on file-watcher ingestion alone.
- [x] Add a one-line edit-link open command for alpha app collaborators.
- [x] Acceptance: an agent can follow the guide without needing provider internals and without the begin/end protocol.

### Task 4: Native Packaging

- [x] Package MarkLab.app using the native packaging path selected in `2026-05-11-marklab-native-integration.md`.
- [x] Ensure installed app can run the hosted `/collab` control-plane/Y-Sweet path without starting a local daemon.
- [x] Register or document a native open-link path for edit links, `marklab://join?url=<encoded-collab-url>`.
- [x] Ensure packaged app bootstrap routes through the native request bridge and does not mint a hidden local relay edit link.
- [x] Ensure packaged CLI includes its runnable entrypoints and agent instruction templates so clean installs do not depend on a repo checkout.
- [x] Ensure normal app users do not need Terminal after install for open/edit/share/join once env/session is configured.
- [ ] Acceptance: clean install on a separate macOS user profile can open, edit, share, and quit. This remains a visual/manual packaging pass, not an automated unit test.

### Task 4A: Native App-To-App Join UX

- [x] Add a native "Join Shared Document..." entry point outside the per-file pre-share inspector. A normal local file window keeps the pre-share toolbar simple: `Start Sharing` is the only collaboration action until sharing starts.
- [x] After `Start Sharing`, expose the collaboration inspector: create edit/view links, show copied-link feedback, list active human collaborators, list active grants/links known to the app session, and allow revoking each grant. Do not show AI agents as collaborators.
- [x] When an edit link is opened in MarkLab.app, validate the link before creating or mutating any local file.
- [x] Let the joining user choose where to create the new local `.md` from the shared document.
- [ ] Attach the shared document to an existing local `.md` with conflict preview when non-empty or diverged. Current pilot safely refuses unbound non-empty same-name files instead of overwriting them.
- [x] Persist the binding between local file and shared document: local file path/bookmark, doc id, branch id, access/session identity, provider doc id/session URL, baseline/fingerprint, and last known app editor URL.
- [x] Reopen restores the hosted `/collab` app session and local file projection from persisted binding without requiring the old daemon.
- [x] Acceptance: App A opens a local file, starts sharing, creates an edit link, and the link is copied. App B opens the same edit link in MarkLab.app, chooses a local folder/path, coedits with App A, writes its own local `.md`, and reconnects after quit/reopen.

### Task 5: Distribution Docs

- [x] Update `README.md` with alpha install path and hosted-default behavior.
- [x] Update `docs/product/marklab-alpha-user-guide.md` with host and collaborator flows.
- [x] Update `docs/Archive/local-daemon-distribution.md` as archived compatibility documentation and move normal users to the new relay/native join flow.
- [x] Update troubleshooting/runbook for host offline, internal error, token expired, revoked link, conflict required, and sync timeout.
- [x] Document the hosted login/workspace requirement for `share`: normal users create or select a workspace, then the app creates a workspace-owned document and edit/view links.
- [x] Document the app-to-app flow: one edit link can be opened in the browser or in MarkLab.app; MarkLab.app asks where to create the local `.md`.
- [x] Acceptance: stale scan still reports historical plan/archive terms; current README/product/production/agent docs are refreshed for the new relay/native path.

### Task 6: Package Smoke

- [x] Pack the CLI from its published package manifest.
- [x] Install packaged CLI into a temporary prefix.
- [x] Run install/open/share/status/wait smoke for the rebound native relay CLI surface. `share` opens MarkLab.app; access-link creation remains native UI-owned.
- [ ] Run the same package smoke against the Fly.io/Neon pilot target, using a test workspace and disposable document after redeploying the new stack.
- [x] Run app-to-app smoke manually on the dev native runtime: App A shares a local file, App B opens the same edit link, both coedit, both local files update, and both reconnect after quit/reopen.
- [x] Run `npx -y pnpm@10.0.0 --filter @marklab/marklab-macos smoke:native-browser` against the dev native/browser runtime.
- [x] Acceptance: package verify confirms the app bundle does not rely on repo-relative editor resources.

### Task 7: Verification

- [x] Run `npx -y pnpm@10.0.0 test apps/cli`.
- [x] Run native package smoke.
- [x] Run docs stale scan: `rg -n "Plan 04A|host-gated|MARKLAB_RELAY_MODE|localhost:3011" README.md docs apps/cli`.
- [x] Run `git diff --check`.
- [ ] Commit with `git commit -m "feat: package marklab alpha cli and docs"`.

### Task 8: Downstream Plan Refresh

- [x] Review packaged URLs, CLI command behavior, native app lifecycle, and docs.
- [x] Update `docs/appdesigndoc.md` if packaging reveals a product workflow change.
- [x] Update these downstream plans:
  - `docs/plans/2026-05-11-billing-subscription-seats.md`
  - `docs/plans/2026-05-11-production-deploy-alpha-launch.md`
- [x] Run `rg -n "install|share|join|doctor|hosted default|daemon|package|alpha" docs/plans docs/appdesigndoc.md README.md`.
- [ ] Commit plan refresh with the implementation commit.
