# Packaging CLI Distribution Docs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package MarkLab so alpha users and AI agents can install it, share local files, join links, diagnose failures, and follow clear docs without reading source code.

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

This plan does not build billing or production deploy. It makes local installation, CLI operation, and user docs reliable enough for alpha smoke testing.

## Provider Runtime Facts From Plan 1B

- Packaged hosted defaults should point users at the hosted API/web origin. Edit clients receive provider URLs from Y-Sweet `ClientToken`s; the CLI should not expose or require a separate provider websocket URL for normal users.
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
- Browser collaborator links should open the public web origin at `/collab?docId=...&branchId=...&token=...&mode=edit|view`. Existing `apps/web` share/access panels now generate that route shape, with assets under `/collab-web/`.
- `/workspaces/:workspaceId/settings` exists in `apps/collab-web` with Members and Documents tabs plus a disabled Plan & Billing placeholder. Packaging/docs should route workspace administration to that browser shell until native settings UI exists.

## File Structure

- Modify `apps/cli/marklab.mjs`
- Modify `apps/cli/relay-config.mjs`
- Modify `apps/cli/doctor.mjs`
- Modify `apps/cli/prepare-package.mjs`
- Modify `apps/cli/*.test.mjs`
- Modify native packaging files from `2026-05-11-marklab-native-integration.md`.
- Modify `README.md`
- Modify `docs/product/marklab-alpha-user-guide.md`
- Modify `docs/production/local-daemon-distribution.md`
- Modify `docs/agent/marklab-agent-guide.md`
- Modify downstream plan files listed in the final task.

## Tasks

### Task 1: Hosted Defaults

- [ ] Ensure packaged CLI defaults to hosted alpha API/provider URLs.
- [ ] Ensure local dev can override URLs with env vars.
- [ ] Ensure `marklab doctor` prints which runtime source and URLs are active.
- [ ] Ensure `marklab doctor --json` includes `/healthz.provider.ready`, `/healthz.provider.storeReady`, and `/healthz.schema.ready` so provider process, provider storage, and provider schema failures are distinguishable.
- [ ] Acceptance command: `node apps/cli/marklab.mjs doctor --json` shows hosted/default/local override state.

### Task 2: CLI Command Coverage

V1 (alpha launch must-have):

- [ ] `open` — open a local Markdown file in MarkLab.app or a sensible default.
- [ ] `share` — start sharing a local file (creates document + edit link).
- [ ] `join` — open a share link (browser fallback if app not installed).
- [ ] `status` — show current sync/conflict state for a file.
- [ ] `wait --synced` — block until sync is complete; used by agents.
- [ ] `conflict` — read current conflict state as JSON for agents.
- [ ] `doctor` — diagnose install, URLs, daemon connectivity.
- [ ] `stop` — stop the local daemon cleanly.

Post-alpha (ship if scope permits, otherwise tag as `coming-soon` in help text):

- [ ] `create-link` — create a new view/edit link without opening UI.
- [ ] `revoke-link` — revoke a link by id.
- [ ] `share-state` — show all current share grants for a file.
- [ ] `save-version` — snapshot the current shared state as a named version.
- [ ] `versions` — list known versions of a shared document.

The CLI is not the home for the agent edit `begin/end` protocol described in the spec; that protocol stays out of v1 (see Task 3).

- [ ] Add tests for hosted-default config and local override config.
- [ ] Add tests proving `share` creates/imports the document into a workspace with `workspaceId` and does not require admin-only auth in hosted mode.
- [ ] Add tests proving `join` preserves `/collab?...` edit/view URLs and does not rewrite them back to legacy hosted relay routes.
- [ ] Acceptance command: `npx -y pnpm@10.0.0 test apps/cli`.

### Task 3: AI Agent Workflow

- [ ] Update `docs/agent/marklab-agent-guide.md`.
- [ ] Document that AI edits local `.md` files directly. The file watcher ingests changes into shared `Y.Text` automatically when a file is part of an active room; AI does not need a special API.
- [ ] Document `wait --synced`, `status`, and `conflict` as the v1 control surface for agents. `save-version` is post-alpha.
- [ ] Document the **deferred** explicit agent edit protocol (`marklab agent edit begin/end`) as post-v1: per `docs/appdesigndoc.md`, v1 relies on file-watcher ingestion alone. If unattended AI rewrites of a shared file produce noisy conflicts, the begin/end protocol gets its own plan; do not ship it in v1.
- [ ] Add a one-line install/share command for alpha users.
- [ ] Acceptance: an agent can follow the guide without needing provider internals and without the begin/end protocol.

### Task 4: Native Packaging

- [ ] Package MarkLab.app using the native packaging path selected in `2026-05-11-marklab-native-integration.md`.
- [ ] Ensure installed app can start local daemon or discover existing daemon.
- [ ] Ensure normal users do not need Terminal after install.
- [ ] Acceptance: clean install on a test macOS user profile can open, edit, share, and quit.

### Task 5: Distribution Docs

- [ ] Update `README.md` with alpha install path and hosted-default behavior.
- [ ] Update `docs/product/marklab-alpha-user-guide.md` with host and collaborator flows.
- [ ] Update `docs/production/local-daemon-distribution.md` with app/CLI lifecycle.
- [ ] Update troubleshooting for host offline, internal error, token expired, revoked link, conflict required, and sync timeout.
- [ ] Document the hosted login/workspace requirement for `share`: normal users create or select a workspace, then the CLI creates a workspace-owned document and edit link.
- [ ] Acceptance: docs include exact commands and no stale Plan 04A relay-only instructions.

### Task 6: Package Smoke

- [ ] Run package preparation.
- [ ] Install packaged CLI into a temporary prefix.
- [ ] Run install/share/join/status/wait smoke against local or staging provider.
- [ ] Acceptance: package smoke passes without relying on repo-relative source paths.

### Task 7: Verification

- [ ] Run `npx -y pnpm@10.0.0 test apps/cli`.
- [ ] Run native package smoke.
- [ ] Run docs stale scan: `rg -n "Plan 04A|host-gated|MARKLAB_RELAY_MODE|localhost:3011" README.md docs apps/cli`.
- [ ] Run `git diff --check`.
- [ ] Commit with `git commit -m "feat: package marklab alpha cli and docs"`.

### Task 8: Downstream Plan Refresh

- [ ] Review packaged URLs, CLI command behavior, native app lifecycle, and docs.
- [ ] Update `docs/appdesigndoc.md` if packaging reveals a product workflow change.
- [ ] Update these downstream plans:
  - `docs/plans/2026-05-11-billing-subscription-seats.md`
  - `docs/plans/2026-05-11-production-deploy-alpha-launch.md`
- [ ] Run `rg -n "install|share|join|doctor|hosted default|daemon|package|alpha" docs/plans docs/appdesigndoc.md README.md`.
- [ ] Commit plan refresh with `git commit -m "docs: refresh plans after packaging"`.
