# Y-Sweet Provider Runtime Ops Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run MarkLab's Y-Sweet-compatible collaboration provider as a deployable, durable service for single-file rooms.

**Architecture:** Keep control plane and provider as separate modules even if the first alpha deploy co-locates them in one Fly app. Use Y-Sweet native provider behavior, a persistent provider store, and health checks that prove the provider can issue tokens, accept websocket sync, and survive process restart without losing document state. Do not implement a custom Yjs sync provider unless upstream Y-Sweet cannot be operated in this environment.

**Tech Stack:** TypeScript, Express, Y-Sweet SDK, upstream Y-Sweet server/runtime selected in Task 1, Yjs, Vitest, Fly.io, Neon Postgres for control-plane metadata, Fly volume or object-store-backed provider persistence.

---

## Scope

This plan starts after Plan 1A exists. It does not build the browser UI or MarkLab.app. It makes the provider runtime real enough that clients can connect, reconnect, and trust persistence.

## File Structure

- Modify `apps/api/src/provider/ysweet-token-service.ts`
- Create `apps/api/src/provider/ysweet-provider-process.ts`
- Create `apps/api/src/provider/ysweet-provider-process.test.ts`
- Modify `apps/api/src/http/app.ts`
- Modify `apps/api/src/config/env.ts`
- Modify `apps/api/src/config/env.test.ts`
- Modify `apps/api/src/index.ts`
- Modify `infra/docker/api.Dockerfile`
- Modify `fly.toml`
- Modify `infra/fly/README.md`
- Modify `docs/production/relay-ops.md`
- Modify downstream plan files listed in the final task.

## Tasks

### Task 1: Runtime Mode Decision

- [ ] Confirm from `Learning resources/y-sweet` whether the provider runs best as an embedded Node-side runtime, sidecar process, or separate Fly process for this repo.
- [ ] Identify the exact upstream command, binary, package, or container image that runs the Y-Sweet server. If upstream does not expose an embeddable Node runtime, choose sidecar/separate-process mode instead of inventing one.
- [ ] Record the chosen alpha mode in `docs/production/relay-ops.md`.
- [ ] Update `fly.toml` comments so the deploy target says whether API and provider are co-located or split.
- [ ] Acceptance: an engineer can read `docs/production/relay-ops.md` and know exactly which upstream Y-Sweet executable owns provider websocket traffic.

### Task 2: Provider Process Module

- [ ] Create `apps/api/src/provider/ysweet-provider-process.ts` with a small interface:
  - `startYSweetProviderProcess(config)`
  - `stopYSweetProviderProcess(handle)`
  - `readYSweetProviderHealth(handle)`
- [ ] This module may supervise an upstream process or check an externally deployed provider. It must not contain custom CRDT sync protocol code.
- [ ] Add `apps/api/src/provider/ysweet-provider-process.test.ts` with unit tests for config parsing, missing config errors, process mode, external-provider mode, and health state.
- [ ] Wire provider process startup in `apps/api/src/index.ts` only when the selected alpha mode says the API process owns provider startup.
- [ ] Acceptance command: `npx -y pnpm@10.0.0 test apps/api/src/provider/ysweet-provider-process.test.ts`.

### Task 3: Persistence Configuration

- [ ] Add provider persistence env vars in `apps/api/src/config/env.ts`.
- [ ] Support alpha local-dev storage under a repo-external data dir, such as `.marklab-provider-data/`.
- [ ] Support alpha production storage through a Fly volume path or object-store path, matching the chosen runtime mode.
- [ ] Ensure `.gitignore` excludes provider local data.
- [ ] Acceptance: a provider restart smoke creates a doc, stops the process, restarts the process, and can read the same doc content.

### Task 4: Provider Health

- [ ] Extend `/healthz` to expose provider readiness separately from process/database/schema readiness.
- [ ] Include provider health in `HttpHealthOptions`.
- [ ] Add tests in `apps/api/src/http/app.test.ts` proving provider-down returns `503` when provider is required.
- [ ] Acceptance command: `npx -y pnpm@10.0.0 test apps/api/src/http/app.test.ts apps/api/src/provider/ysweet-provider-process.test.ts`.

### Task 5: End-To-End Provider Smoke

- [ ] Add a smoke script under `scripts/` or `apps/api/src/provider/` that:
  - starts API/provider with test config;
  - requests an edit collab session;
  - connects a Yjs client;
  - writes `Y.Text("contents")`;
  - reconnects and reads the same text.
- [ ] Add a read-only malicious write smoke if trusted live read-only provider tokens are enabled in this stage.
- [ ] Acceptance command: run the smoke locally and document the command in `docs/production/relay-ops.md`.

### Task 6: Docker And Fly Wiring

- [ ] Update `infra/docker/api.Dockerfile` to install/build everything required by the provider runtime.
- [ ] Update `fly.toml` env defaults for provider URL, provider store path, public API URL, and public websocket URL.
- [ ] Update `infra/fly/README.md` with the new required secrets and persistent storage steps.
- [ ] Acceptance command: `docker build -f infra/docker/api.Dockerfile .` completes locally.

### Task 7: Verification

- [ ] Run `npx -y pnpm@10.0.0 test apps/api/src/provider apps/api/src/http/app.test.ts`.
- [ ] Run `npx -y pnpm@10.0.0 exec tsc --noEmit -p apps/api/tsconfig.json`.
- [ ] Run `git diff --check`.
- [ ] Commit with `git commit -m "feat: add ysweet provider runtime ops"`.

### Task 8: Downstream Plan Refresh

- [ ] Review the final provider runtime diff, env vars, storage choice, and smoke command.
- [ ] Update `docs/appdesigndoc.md` if runtime/deploy/storage decisions changed.
- [ ] Update these downstream plans:
  - `docs/superpowers/plans/2026-05-11-collab-web-app.md`
  - `docs/superpowers/plans/2026-05-11-marklab-native-integration.md`
  - `docs/superpowers/plans/2026-05-11-control-plane-mvp.md`
  - `docs/superpowers/plans/2026-05-11-reconnect-conflict-hardening.md`
  - `docs/superpowers/plans/2026-05-11-packaging-cli-distribution-docs.md`
  - `docs/superpowers/plans/2026-05-11-billing-subscription-seats.md`
  - `docs/superpowers/plans/2026-05-11-production-deploy-alpha-launch.md`
- [ ] Run `rg -n "Hocuspocus|provider token|Y-Sweet|storage|Fly volume|object store|healthz" docs/superpowers/plans docs/appdesigndoc.md`.
- [ ] Commit plan refresh with `git commit -m "docs: refresh plans after provider runtime"`.
