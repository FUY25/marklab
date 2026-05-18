# Production Deploy Alpha Launch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy MarkLab alpha to production infrastructure with verified provider persistence, control-plane health, browser/native collaboration smoke, rollback, and launch documentation.

**Architecture:** Deploy the API/control plane/provider/web surfaces according to the final co-located or split-service decision from Plan 1B. Neon stores control-plane metadata, provider persistence uses the selected durable store, and health checks must prove database, schema, provider, and web readiness before user traffic.

**Tech Stack:** Fly.io, Neon Postgres, MarkLab Docker images, provider persistence selected in Plan 1B, optional billing provider from Plan 7, CLI/native package from Plan 6.

## Reference Implementations (MIT — OK to copy)

This plan is mostly MarkLab-specific deploy/ops work. The one valuable reference is Y-Sweet's MIT-licensed deployment examples for production provider topology.

**Rules of reuse:**

1. **Default to copying, not re-deriving.** Y-Sweet's production deploy examples encode hard-won knowledge about websocket termination, persistence, and process layout. Lift directives directly into MarkLab's Fly/Caddy config rather than re-discovering the gotchas.
2. **`Learning resources/` is read-only as a directory.** Never edit, move, delete, or `git add` anything under it. Read freely; paste into MarkLab-owned config/scripts.
3. **Preserve attribution.** Copy the upstream LICENSE/copyright header as a comment in adopted config files.

| This plan's task | Lift from | What to copy |
|---|---|---|
| Task 2 (build and release path) | `Learning resources/y-sweet/deploy/` (`docker-compose.yml`, `Caddyfile`, `README.md`) | Production deploy topology — env vars, websocket termination, volume mounts. Plan 1B already lifted the alpha shape; revisit here for production-grade settings and copy any additional directives into MarkLab's `fly.toml` / Caddy config / Dockerfile. |
| Task 5 (provider persistence gate) | `Learning resources/y-sweet/docs/` | Storage backend options and durability expectations under restart/migrate. |
| All other tasks | (no learning-resource reference) | Original MarkLab deploy/ops work. |

---

## Scope

This plan is the launch gate. It does not add product features. It verifies the feature set implemented by previous plans and publishes it to alpha users.

## Provider Runtime Facts From Plan 1B

- The alpha deploy shape is co-located: one Fly app serves API/web and supervises an upstream Y-Sweet 0.9.1 child process on `127.0.0.1:8080`.
- Provider public URL prefix is `https://<fly-app>.fly.dev` in process mode and must be root-mounted; path-prefixed public provider URLs are rejected.
- Fly volume `marklab_ysweet_data` is mounted at `/data`, with provider store path `/data/ysweet`. Local provider data is `.marklab-provider-data/ysweet`.
- Provider secrets are `MARKLAB_YSWEET_AUTH` (private key forwarded to child as `Y_SWEET_AUTH`, not argv) and `MARKLAB_YSWEET_SERVER_TOKEN` (SDK/check_store token). Both come from `y-sweet gen-auth --json`.
- `/healthz` must show `database.ready=true`, `schema.ready=true`, `relay.ready=true`, `provider.ready=true`, and `provider.storeReady=true`. Schema readiness includes provider/session tables and required provider columns.
- Docker image build acceptance may be blocked locally if the Docker daemon is not running; record that separately from Fly deploy credentials.

## Control Plane Facts From Plan 2

- Production must run login-backed: set `MARKLAB_REQUIRE_AUTH=true`, leave `MARKLAB_ENABLE_DEV_ANONYMOUS_COLLAB` unset/false, and do not depend on `/api/auth/dev-login`. `NODE_ENV=production` disables dev login even if `MARKLAB_ENABLE_DEV_AUTH=true`.
- Schema readiness must include the control-plane tables and columns added in Plan 2: `users`, `workspaces`, `workspace_members`, `workspace_share_keys`, `workspace_folders`, `folder_access_policies`, `plans`, `seat_limits`, `subscriptions`, `document_access_grants`, `document_access_sessions`, `collab_sessions`, `provider_token_issuances`, and `provider_token_refreshes`.
- Hosted public editing must go through the control-plane session route and Y-Sweet `ClientToken`s. Legacy hosted relay/websocket shortcuts are not a production acceptance path.
- Launch smoke must create or select a workspace, create/import a workspace-owned document with `workspaceId`, create a view/edit grant, join as browser/native, refresh edit provider tokens, and verify revocation denial.
- Guest quota and member-seat checks are already plan-table-backed for workspace-owned documents. Plan 7 may add Stripe/manual billing management, but production manual/free mode must still prove deterministic limits.

## Browser Facts From Plan 3

- The alpha browser surface is co-located with the API process. `infra/docker/api.Dockerfile` builds `apps/collab-web`, copies `apps/collab-web/dist`, and sets `MARKLAB_COLLAB_WEB_DIST_DIR=/app/apps/collab-web/dist`.
- Static collab-web assets are served under `/collab-web/`. Browser collaborator routes are `/collab?docId=...&branchId=...&token=...&mode=edit|view`, and workspace settings are `/workspaces/:workspaceId/settings`.
- Plan 3's automated browser suite includes both memory-provider collaboration tests and a real API-root Y-Sweet websocket browser smoke; production still needs the same path verified against deployed infrastructure.
- Production smoke must verify `/collab` serves the collab-web entry, `/collab-web/assets/...` assets load, existing `apps/web` routes such as `/relay/...` still load, view mode opens without provider websocket traffic, and edit mode refresh denial surfaces unavailable.

## Native Facts From Plans 4 And 5.5

- Native source is `apps/marklab-macos/` and package/deploy docs should treat it as the MarkLab.app source of truth for alpha. It is not deployed by Fly, but launch readiness depends on the CLI/native package produced from this repo.
- MarkLab.app uses a MarkEdit-derived document shell with bundled CodeMirror-in-WebKit local Markdown editing, toolbar/status/inspector collaboration controls, and a document-scoped conflict panel. Production/package smoke should catch regressions back to the old prototype root layout.
- MarkLab.app embeds the hosted `/collab` editor through a WKWebView for shared editing. Production origin and CORS/CSP settings must allow the native app to load the hosted collab route while keeping API credential injection restricted to same-origin `/api/` requests.
- The API must preserve `clientKind=app` only for native user bearer requests with `X-MarkLab-Native-App: 1` and a non-guest actor. Production smoke should verify a public browser link cannot spoof app kind and that the native embedded client becomes unavailable if the server downgrades app kind.
- Native local state should use the hosted `/collab` control-plane/Y-Sweet path by default. The legacy CLI daemon boundary (`marklab share --json --daemon-only` plus `/api/local/app-context`) is opt-in compatibility only through `MARKLAB_APP_ENABLE_LOCAL_DAEMON_BOUNDARY=1`; production/package smokes must prove the default path does not start it and the opt-in path does not mint hidden relay grants.
- Native local smoke command is `npx -y pnpm@10.0.0 --filter @marklab/marklab-macos smoke:native-browser`. It proves app-kind/browser convergence, disk projection, shell/runtime gates, and cursor exchange locally. Production launch still needs a deployed-infrastructure native host plus browser guest smoke using the packaged app/CLI.

## File Structure

- Modify `fly.toml`
- Modify `infra/docker/api.Dockerfile`
- Do not add `infra/docker/collab-web.Dockerfile` unless this plan explicitly changes the co-located Plan 3 deploy shape.
- Modify `infra/fly/README.md`
- Modify `docs/production/relay-ops.md`
- Create or modify `docs/production/alpha-launch-runbook.md`
- Modify `README.md`
- Modify `.env.example` if present, or create an alpha env example if the repo does not have one.

## Tasks

### Task 1: Pre-Deploy Inventory

- [ ] Confirm all previous plans have passed their verification gates.
- [ ] Record final production service shape:
  - API/control plane;
  - provider;
  - collab-web served by the API image unless this plan changes the deploy shape;
  - native app/CLI distribution;
  - database;
  - provider persistence;
  - billing mode.
- [ ] Acceptance: `docs/production/alpha-launch-runbook.md` contains the final topology and operator contacts.

### Task 2: Build And Release Path

- [ ] Decide whether alpha deploy is manual `fly deploy` only or GitHub Actions backed.
- [ ] If manual, document the exact local build, test, deploy, and rollback commands in `docs/production/alpha-launch-runbook.md`.
- [ ] If GitHub Actions backed, add workflow files for test, image build, deploy, and smoke trigger.
- [ ] Tag every alpha deploy with a git commit SHA and release label so rollback can point to a known artifact.
- [ ] Acceptance: an operator can answer "which exact commit is running in production?" without reading Fly logs manually.

### Task 3: Secrets And Environment

- [ ] List required secrets for:
  - `DATABASE_URL`;
  - public API URL;
  - public web URL;
  - `MARKLAB_REQUIRE_AUTH=true`;
  - auth/session signing secret or OIDC config selected by the auth implementation;
  - `MARKLAB_YSWEET_PUBLIC_URL_PREFIX=https://<fly-app>.fly.dev` if the Fly app name differs from checked-in `fly.toml`;
  - `MARKLAB_YSWEET_AUTH`;
  - `MARKLAB_YSWEET_SERVER_TOKEN`;
  - provider store path or object-store credentials if the Plan 1B Fly-volume default is changed;
  - auth/session secret;
  - billing secrets when Plan 7 is enabled.
- [ ] Set secrets in Fly.
- [ ] Acceptance: `fly secrets list` shows names without printing values, and `/healthz` does not expose secret content.

### Task 4: Database Migration

- [ ] Apply `apps/api/src/db/schema.sql` or the migration command produced by earlier plans to Neon.
- [ ] Record whether migrations are one-shot SQL, an app-owned migration command, or a CI deploy step.
- [ ] Verify required tables and columns exist.
- [ ] Acceptance: `/healthz` reports `database.ready=true`, `schema.ready=true`, `relay.ready=true`, `provider.ready=true`, and `provider.storeReady=true`; the database migration task does not pass the launch gate unless relay and provider readiness also remain green.

### Task 5: Provider Persistence Gate

- [ ] Deploy provider storage.
- [ ] Ensure Fly volume `marklab_ysweet_data` exists in the deployed region and is mounted at `/data`.
- [ ] Run a persistence smoke:
  - create collab session;
  - write provider doc;
  - restart process or machine;
  - reconnect;
  - verify content still exists.
- [ ] Acceptance: provider persistence smoke passes against production/staging infrastructure.

### Task 6: Deploy Images

- [ ] Build production image locally or in Fly.
- [ ] Deploy with `fly deploy`.
- [ ] Confirm machine count, region, health checks, and logs.
- [ ] Acceptance commands:
  - `fly status`
  - `fly logs`
  - `curl https://<marklab-host>/healthz`

### Task 7: Product Smoke

- [ ] Run browser edit smoke.
- [ ] Run view-link no-provider-websocket smoke.
- [ ] Run collab-web static route smoke for `/collab`, `/collab-web/assets/...`, and an existing `apps/web` route such as `/relay/...`.
- [ ] Run workspace-owned document smoke: login, create workspace, create/import document with `workspaceId`, list it through `/api/workspaces/:workspaceId/documents`, create edit/view grants.
- [ ] Run native host plus browser guest smoke.
- [ ] Run native app-kind spoofing smoke: public browser/cookie-authenticated traffic with `clientKind=app` is downgraded, while packaged MarkLab.app bearer plus `X-MarkLab-Native-App: 1` is preserved as app kind.
- [ ] Run CLI share/join/status/wait smoke.
- [ ] Run conflict/reconnect smoke.
- [ ] Run revoked link smoke.
- [ ] Run member-seat and guest-edit-quota smoke in manual/free mode; add Stripe-specific smoke only if Plan 7 stripe mode is enabled.
- [ ] Acceptance: every smoke has a recorded command, result, and timestamp in the launch runbook.

### Task 8: Observability And Rollback

- [ ] Confirm logs identify database, provider, auth, token, quota, conflict, and websocket failures.
- [ ] Add rollback command to launch runbook.
- [ ] Add backup/restore note for database and provider persistence.
- [ ] Acceptance: an operator can roll back the last deploy and explain what user data is preserved.

### Task 9: Launch Docs

- [ ] Update `README.md` with current alpha install and share instructions.
- [ ] Update `docs/product/marklab-alpha-user-guide.md`.
- [ ] Update `docs/production/alpha-launch-runbook.md`.
- [ ] Remove or clearly archive stale Plan 04A-only instructions.
- [ ] Acceptance: docs route a new alpha user through install, open, share, browser join, and troubleshooting.

### Task 10: Final Verification

- [ ] Run full repo test command selected by current package scripts.
- [ ] Run API and web typechecks.
- [ ] Run production smoke.
- [ ] Run `git diff --check`.
- [ ] Commit with `git commit -m "chore: prepare marklab alpha deploy"`.

### Task 11: Final Plan And Spec Refresh

- [ ] Review actual deployed topology, smoke results, package URLs, billing mode, and known launch gaps.
- [ ] Update `docs/appdesigndoc.md` with any final product/architecture truth that differs from the earlier spec.
- [ ] Update `docs/plans/2026-05-11-marklab-alpha-plan-roadmap.md` with completed status for all plans.
- [ ] Run `rg -n "Plan 04A|host-gated|Hocuspocus first|stub auth|internal technical slice|not public" docs README.md`.
- [ ] Commit final refresh with `git commit -m "docs: refresh alpha launch truth"`.
