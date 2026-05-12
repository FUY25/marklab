# Y-Sweet Provider Runtime Ops Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run MarkLab's Y-Sweet-compatible collaboration provider as a deployable, durable service for single-file rooms.

**Architecture:** Keep control plane and provider as separate modules even if the first alpha deploy co-locates them in one Fly app. Use Y-Sweet native provider behavior, a persistent provider store, and health checks that prove the provider can issue tokens, accept websocket sync, and survive process restart without losing document state. Do not implement a custom Yjs sync provider unless upstream Y-Sweet cannot be operated in this environment.

**Tech Stack:** TypeScript, Express, Y-Sweet SDK, upstream Y-Sweet server/runtime selected in Task 1, Yjs, Vitest, Fly.io, Neon Postgres for control-plane metadata, Fly volume or object-store-backed provider persistence.

## Reference Implementations (MIT — OK to copy)

These files in `Learning resources/y-sweet/` are MIT-licensed working configurations. You may copy compose files, env var names, and example client code directly into MarkLab-owned files to save work.

**Rules of reuse:**

1. **Default to copying, not re-deriving.** Y-Sweet's `deploy/` directory contains working production configurations. Lift them and adapt — do not re-derive your own docker-compose / Caddy / env-var conventions when y-sweet's already work. The reference table below is the "already-done" inventory.
2. **`Learning resources/` is read-only as a directory.** Never edit, move, delete, or `git add` anything under it. Read from it freely; paste relevant snippets into MarkLab-owned config and scripts.
3. **Preserve attribution.** When you copy non-trivial config or code, paste the upstream LICENSE/copyright header as a comment.
4. **Adapt to MarkLab's Fly/Docker layout** — do not run y-sweet's docker-compose unmodified in production.

| This plan's task | Lift from | What to copy |
|---|---|---|
| Task 1 (runtime mode decision) | `Learning resources/y-sweet/README.md`, `Learning resources/y-sweet/docs/` | The supported runtime modes (binary, Docker, embedded). Read these first; the mode decision flows from understanding these options. |
| Task 1 (binary vs server) | `Learning resources/y-sweet/crates/y-sweet/` (Rust server) and `Learning resources/y-sweet/js-pkg/server/` (Node helpers) | Identify the exact artifact MarkLab supervises. The Rust binary is the production-grade target. |
| Task 2 (provider process supervision) | `Learning resources/y-sweet/deploy/docker-compose.yml` | The y-sweet service block — env vars, volume mounts, networking. Lift the env var names and storage path conventions; adapt the service shape into MarkLab's `fly.toml`. |
| Task 2 (reverse proxy / websocket termination) | `Learning resources/y-sweet/deploy/Caddyfile` | The websocket-upgrade rules and `/doc/*` routing. Copy the relevant directives into MarkLab's chosen proxy config. |
| Task 3 (persistence config) | `Learning resources/y-sweet/docs/` and `Learning resources/y-sweet/crates/y-sweet/src/` | Storage backend options (filesystem / S3 / object store). Copy env var names where possible to reduce ops cognitive load. |
| Task 4 (health endpoint contract) | `Learning resources/y-sweet/crates/y-sweet/` (search for `health` / `ready`) | The upstream health endpoint format if exposed — call through it from MarkLab's `/healthz` rather than reimplementing. |
| Task 5 (end-to-end smoke) | `Learning resources/y-sweet/examples/nextjs/` and `Learning resources/y-sweet/examples/vanilla/` | Working Yjs client connection examples. Lift the connection-setup code for the smoke script. |

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

### Task 1.5: Plan Reshape Gate

The rest of this plan (Tasks 2–7) is written assuming **the API process supervises a local Y-Sweet child process** and reads its health. If Task 1 picks a different mode, Tasks 2–7 must be rewritten before any code lands:

- If Y-Sweet runs as a **separate Fly process or machine**: drop `ysweet-provider-process.ts` and its supervision tests. Replace with a thin HTTP/WS client module that probes the external provider URL and a Fly deploy config for the provider machine. Persistence (Task 3) moves to the provider machine's volume.
- If Y-Sweet runs as an **embedded library/binary linked into the API process** (no separate process): drop the supervision interface. Replace with library bootstrap inside `apps/api/src/provider/ysweet-provider-runtime.ts`. Persistence (Task 3) moves into the API process's volume.
- If Y-Sweet runs as a **sidecar container/process managed by the orchestrator** (not the API process): drop supervision. Add health probes against the sidecar URL only. Persistence config lives in the sidecar's deployment spec.

Subtasks:

- [ ] After Task 1 decides the mode, mark the irrelevant Tasks 2–7 wording in this plan as "skip" or replace it with the mode-specific equivalent.
- [ ] If the mode is anything other than "API process supervises a child process", rename `apps/api/src/provider/ysweet-provider-process.ts` to a mode-appropriate name in Tasks 2–4 before implementing.
- [ ] Acceptance: the remaining tasks in this plan name file paths and module shapes that match the chosen runtime mode. An implementer does not have to guess.

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
- [ ] Pick and document a Yjs garbage-collection policy: alpha default is `gc: true` (Yjs default), which removes tombstones from the in-memory CRDT but preserves the update log. Snapshots are recompacted on a cadence selected here (default: every 100 updates or every 5 minutes, whichever comes first). Record the chosen values in `docs/production/relay-ops.md` so view-link history horizon expectations are documented.
- [ ] Acceptance: a provider restart smoke creates a doc, stops the process, restarts the process, and can read the same doc content. A separate smoke writes 200 updates and confirms snapshot compaction reduces the on-disk update count.

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
- [ ] Skip the read-only malicious-write smoke in v1: per `docs/appdesigndoc.md` locked decision 11, v1 view links are control-plane snapshots and do not use the provider. Re-enable this smoke only when a future plan introduces trusted live read-only provider tokens.
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
  - `docs/plans/2026-05-11-collab-web-app.md`
  - `docs/plans/2026-05-11-marklab-native-integration.md`
  - `docs/plans/2026-05-11-control-plane-mvp.md`
  - `docs/plans/2026-05-11-reconnect-conflict-hardening.md`
  - `docs/plans/2026-05-11-packaging-cli-distribution-docs.md`
  - `docs/plans/2026-05-11-billing-subscription-seats.md`
  - `docs/plans/2026-05-11-production-deploy-alpha-launch.md`
- [ ] Run `rg -n "Hocuspocus|provider token|Y-Sweet|storage|Fly volume|object store|healthz" docs/plans docs/appdesigndoc.md`.
- [ ] Commit plan refresh with `git commit -m "docs: refresh plans after provider runtime"`.
