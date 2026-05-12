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

## File Structure

- Modify `fly.toml`
- Modify `infra/docker/api.Dockerfile`
- Modify or add `infra/docker/collab-web.Dockerfile` if the web app deploys separately.
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
  - collab-web;
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
  - public provider websocket URL;
  - provider connection string;
  - provider store path or object-store credentials;
  - auth/session secret;
  - billing secrets when Plan 7 is enabled.
- [ ] Set secrets in Fly.
- [ ] Acceptance: `fly secrets list` shows names without printing values, and `/healthz` does not expose secret content.

### Task 4: Database Migration

- [ ] Apply `apps/api/src/db/schema.sql` or the migration command produced by earlier plans to Neon.
- [ ] Record whether migrations are one-shot SQL, an app-owned migration command, or a CI deploy step.
- [ ] Verify required tables and columns exist.
- [ ] Acceptance: `/healthz` reports `database.ready=true` and `schema.ready=true`.

### Task 5: Provider Persistence Gate

- [ ] Deploy provider storage.
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
- [ ] Run native host plus browser guest smoke.
- [ ] Run CLI share/join/status/wait smoke.
- [ ] Run conflict/reconnect smoke.
- [ ] Run revoked link smoke.
- [ ] Run seat/guest quota smoke if Plan 7 is enabled.
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
