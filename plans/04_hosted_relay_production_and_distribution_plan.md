# Hosted Relay Production And Distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Plan 02/03 hosted relay production-ready and make the local MarkLab daemon installable without turning MarkLab into a heavy document workspace.

**Architecture:** The production product is a local daemon plus browser UI plus hosted relay. The hosted service owns links, session identity, permissions, relay routing, and observability; local files remain canonical for daemon participants. Distribution starts as an npm/CLI alpha, moves to a stable CLI install channel, and can add a small menubar daemon manager without building a native editor client.

**Tech Stack:** Node.js/TypeScript, Express, WebSocket/Hocuspocus-compatible relay, Postgres, Vite/React web UI, local CLI daemon, optional macOS menubar wrapper, Docker-compatible production packaging.

---

## Product Scope

This plan starts after:

- Plan 01 local file sync has durable local metadata and local-token hardening.
- Plan 02 hosted relay has host-authority write gating.
- Plan 03 reconnect conflict review has paused-state recovery.

Plan 04 does not add new collaboration semantics. It makes the existing semantics shippable.

In scope:

- production hosted relay configuration;
- relay security, rate limits, and origin policy;
- relay observability and operational runbooks;
- CLI distribution and production packaging for the Plan 01 daemon lifecycle;
- optional lightweight menubar daemon manager built on the Plan 01 supervisor;
- production URL and environment configuration;
- user-facing docs for local-first privacy and host-online behavior.

Out of scope:

- fully offline distributed multi-master sync;
- cloud document manager;
- left-sidebar workspace database;
- native Markdown editor app;
- hosted AI write/edit APIs.

## Product Shape

The product should feel like:

```text
marklab open README.md
```

not:

```text
Upload this file into a new cloud workspace.
```

Production shape:

```text
Local daemon
  -> watches/writes local Markdown files
  -> opens browser UI
  -> connects to hosted relay only when sharing

Browser UI
  -> editor canvas
  -> versions
  -> share
  -> conflict review

Hosted relay
  -> links
  -> sessions
  -> permissions
  -> websocket relay
  -> host-online state
  -> telemetry for reliability, not canonical document storage
```

## Host Online Semantics

Production copy must make this plain:

```text
Host online means the MarkLab daemon is running and connected.
```

It does not mean only that the host computer is powered on.

Accepted production behavior:

- If the CLI process is foreground-only, closing the terminal stops hosting.
- If the user runs a background daemon or menubar manager, the terminal can close and hosting continues.
- Closing the browser tab does not stop hosting if the daemon is still alive.
- Sleep, network loss, daemon crash, or websocket lease expiry makes the relay mark host offline.
- While host offline, browser edit links and local mirror daemons cannot commit global writes.

## Distribution Strategy

Use staged distribution. Do not start with a heavy app.

Stage A, alpha:

```text
npx -y @marklab/cli open README.md
npx -y @marklab/cli share README.md
npx -y @marklab/cli join <edit-link> --dir ./docs --name README.md
```

Stage B, beta:

```text
brew install marklab
marklab open README.md
marklab share README.md
marklab join <edit-link> --dir ./docs --name README.md
```

Stage C, production:

```text
signed standalone CLI
optional menubar daemon manager
```

The menubar is not a native editor. It only manages daemon processes through the Plan 01 supervisor:

- running files;
- relay connection status;
- host online/offline state;
- share state summary;
- recent local files;
- pause/resume;
- open browser;
- quit daemon;
- update available.

## Local Mirror Join Creation Flow

Plan 02 owns the sync protocol. Production distribution must preserve this CLI UX:

```text
marklab join <edit-link> ./README.md
```

Open or create the exact file.

```text
marklab join <edit-link> --dir ./docs
```

Create a safe filename in the selected directory from relay metadata.

```text
marklab join <edit-link> --dir ./docs --name shared-notes.md
```

Create exactly `./docs/shared-notes.md`.

For AI agents:

```text
marklab join <edit-link> --dir ./docs --name README.md
```

This is the supported path. AI agents should not call hosted write/edit APIs.

## Deployment Target

Plan 04's default deployment target is Docker-compatible hosted relay deployment with Fly.io-style example config. Docker is the portability boundary; Fly-style config is the first documented production path because it handles long-lived WebSockets and Postgres without changing application code.

The app contract must stay portable enough to run on Render, Railway, or a VPS later:

```text
PORT
DATABASE_URL
MARKLAB_PUBLIC_WEB_URL
MARKLAB_PUBLIC_API_URL
MARKLAB_PUBLIC_RELAY_WS_URL
MARKLAB_REQUIRE_AUTH=true
MARKLAB_RELAY_EPHEMERAL_TTL_SECONDS
MARKLAB_RELAY_HOST_LEASE_SECONDS
MARKLAB_RELAY_MAX_ROOM_CONNECTIONS
MARKLAB_RELAY_MAX_MESSAGE_BYTES
MARKLAB_ALLOWED_ORIGINS
```

## File Structure

Create or modify these files:

```text
apps/api/src/config/env.ts
apps/api/src/relay/relay-production-config.ts
apps/api/src/relay/relay-limits.ts
apps/api/src/relay/relay-observability.ts
apps/api/src/relay/relay-server.ts
apps/api/src/relay/relay-room-service.ts
apps/api/src/index.ts
apps/api/src/http/app.ts
apps/api/src/db/schema.sql
apps/cli/package.json
apps/cli/marklab.mjs
apps/cli/relay-config.mjs
apps/cli/daemon-supervisor.mjs
apps/cli/README.md
apps/web/src/lib/api-client.ts
apps/web/src/pages/LocalDocumentPage.tsx
apps/web/src/pages/RelayDocumentPage.tsx
apps/web/tests/relay-collaboration.spec.ts
apps/web/tests/local-conflict-review.spec.ts
infra/docker/api.Dockerfile
infra/docker/web.Dockerfile
infra/docker/docker-compose.prod-smoke.yml
infra/fly/fly.toml.example
infra/fly/README.md
.github/workflows/cli-release.yml
docs/production/relay-ops.md
docs/production/local-daemon-distribution.md
docs/production/privacy-and-storage.md
```

If the optional menubar manager is implemented in this plan, add:

```text
apps/menubar/package.json
apps/menubar/src/main.ts
apps/menubar/src/daemon-control.ts
apps/menubar/src/status-menu.ts
apps/menubar/README.md
```

The menubar task is optional for Plan 04 completion. The production CLI and hosted relay must work without it because Plan 01 already owns the minimal foreground/background daemon lifecycle.

## Task 1: Production Environment Contract

**Files:**

- Create: `apps/api/src/config/env.ts`
- Create: `apps/api/src/relay/relay-production-config.ts`
- Modify: `apps/api/src/index.ts`
- Test: `apps/api/src/config/env.test.ts`

- [ ] Define a typed environment loader for production relay settings.
- [ ] Reject production start when required URLs or `DATABASE_URL` are missing.
- [ ] Default development mode to localhost-safe values.
- [ ] Parse numeric limits as integers and reject invalid values.
- [ ] Verify `MARKLAB_REQUIRE_AUTH=true` is required for hosted production mode.
- [ ] Add tests for missing env, invalid numbers, development defaults, and production happy path.

Acceptance criteria:

- Production misconfiguration fails at startup with a specific message.
- Local file mode still runs without `DATABASE_URL`.
- Hosted relay mode never starts in production with auth disabled.

## Task 2: Relay Security And Abuse Limits

**Files:**

- Create: `apps/api/src/relay/relay-limits.ts`
- Modify: `apps/api/src/relay/relay-server.ts`
- Modify: `apps/api/src/http/app.ts`
- Test: `apps/api/src/relay/relay-limits.test.ts`
- Test: `apps/api/src/relay/relay-server.test.ts`

- [ ] Enforce max websocket message bytes.
- [ ] Enforce max connections per relay room.
- [ ] Enforce max rooms per host session.
- [ ] Enforce heartbeat interval and host lease expiry.
- [ ] Reject write attempts when host lease expired.
- [ ] Enforce allowed origins for hosted relay and browser routes.
- [ ] Keep local daemon loopback-token auth separate from hosted relay link auth.

Acceptance criteria:

- Oversized relay messages are rejected and do not kill the process.
- Host lease expiry transitions room to `host_offline`.
- Edit writes during `host_offline` return a clear rejection.
- View-only websocket clients cannot send accepted edit updates.

## Task 3: Relay Persistence And Cleanup

**Files:**

- Modify: `apps/api/src/db/schema.sql`
- Modify: `apps/api/src/relay/relay-room-service.ts`
- Test: `apps/api/src/relay/relay-room-service.test.ts`

- [ ] Add production indexes for relay rooms, grants, sessions, and expiration lookups.
- [ ] Store token hashes only, never raw relay tokens.
- [ ] Store accepted shared revision and hash for stale-conflict detection.
- [ ] Store ephemeral Yjs state with TTL metadata.
- [ ] Add cleanup for expired grants, stale sessions, and expired ephemeral room cache.
- [ ] Prove cleanup never deletes local files or local metadata.

Acceptance criteria:

- Relay cache deletion only affects hosted relay rows.
- Revoked link sessions are disconnected without ending unrelated links.
- Expired ephemeral state is labeled unavailable rather than treated as canonical deletion.

## Task 4: Production Web And Relay URLs

**Files:**

- Modify: `apps/web/src/lib/api-client.ts`
- Modify: `apps/web/src/pages/LocalDocumentPage.tsx`
- Modify: `apps/web/src/pages/RelayDocumentPage.tsx`
- Modify: `apps/cli/relay-config.mjs`
- Create: `apps/web/tests/relay-collaboration.spec.ts`
- Create or require from Plan 03: `apps/web/tests/local-conflict-review.spec.ts`
- Test: `apps/cli/relay-config.test.mjs`

- [ ] Centralize public API, web, and relay websocket URL construction.
- [ ] Support local development URLs and production hosted URLs.
- [ ] Ensure local URLs with daemon tokens are never copied as share links.
- [ ] Ensure Share produces hosted relay links only.
- [ ] Ensure view links route to browser read-only and edit links route to editable browser or CLI join instructions.
- [ ] Add relay browser E2E coverage owned by this plan.
- [ ] Wire the conflict review E2E from Plan 03 into the production smoke command when Plan 03 is present.

Acceptance criteria:

- Copying a share link never exposes the local daemon token.
- View links cannot launch local mirror join.
- Edit links include enough metadata for `marklab join` validation without exposing raw token hashes.
- E2E tests run against the documented test DB/API setup, not against an accidental developer local service.

## Task 5: CLI Distribution And Production Daemon Integration

**Files:**

- Create: `apps/cli/package.json`
- Create: `apps/cli/README.md`
- Modify: `apps/cli/marklab.mjs`
- Create: `apps/cli/daemon-supervisor.mjs`
- Create: `apps/cli/relay-config.mjs`
- Modify: `package.json`
- Create: `.github/workflows/cli-release.yml`
- Test: `apps/cli/marklab-cli.test.mjs`
- Test: `apps/cli/package-install-smoke.test.mjs`

- [ ] Package `@marklab/cli` as the alpha install artifact with `bin.marklab`, `type`, `engines.node`, `files`, and workspace dependency handling.
- [ ] Prove the packed CLI does not require a repo checkout.
- [ ] Run `pnpm --filter @marklab/cli pack --dry-run` and inspect included files.
- [ ] Install the packed tarball in a clean temp directory and run `marklab --help`, `marklab open --help`, `marklab share --help`, and `marklab join --help`.
- [ ] Add a release workflow that can publish `@marklab/cli` only after typecheck, unit tests, package install smoke, and manual approval.
- [ ] Keep `marklab open README.md` as local-only.
- [ ] Keep `marklab share README.md` as local open plus relay host session.
- [ ] Preserve Plan 01 foreground/background behavior for `marklab open README.md` and `marklab open README.md --background`.
- [ ] Ensure `marklab status`, `marklab stop README.md`, and `marklab stop --all` work with the packaged CLI.
- [ ] Keep `marklab join <edit-link> ./README.md` as exact target path.
- [ ] Add `marklab join <edit-link> --dir ./docs`.
- [ ] Add `marklab join <edit-link> --dir ./docs --name shared-notes.md`.
- [ ] Reject host-offline edit links before directory creation, file creation, file write, watcher startup, or relay proposal.
- [ ] Reject view links before directory creation, file creation, file write, watcher startup, or relay proposal.
- [ ] For existing non-empty targets, create a pending join conflict candidate before any watcher starts.
- [ ] Add clear process behavior: foreground by default, `--background` uses the Plan 01 supervisor.
- [ ] On Ctrl-C, shut down API/web/relay child processes cleanly.
- [ ] If a child process exits, shut down siblings and print the failing process name.
- [ ] Print explicit host-online copy when sharing starts.

Acceptance criteria:

- A user understands whether closing the terminal will stop hosting.
- Packaged foreground/background behavior matches Plan 01 exactly.
- The packaged CLI does not create a second daemon registry or lifecycle model.
- AI agents can create a synced local Markdown file using only the CLI command.
- CLI tests cover exact path, directory creation with `--create-dir`, generated name conflict, and view-link rejection.
- Host-offline `marklab join <edit-link> --dir ./docs --name README.md` creates no file and starts no daemon.
- Host-offline `marklab join` against an existing file leaves bytes unchanged.
- Existing non-empty target plus `Review conflict` leaves file bytes unchanged until explicit resolution.
- Existing non-empty target plus `Cancel` leaves no relay session and no watcher.
- Existing non-empty target plus `Replace with shared version` requires explicit confirmation and writes only the host-authorized shared revision.
- Main editor is read-only while join conflict review is open.

## Task 6: Optional Menubar Daemon Manager

**Files:**

- Create: `apps/menubar/package.json`
- Create: `apps/menubar/src/main.ts`
- Create: `apps/menubar/src/daemon-control.ts`
- Create: `apps/menubar/src/status-menu.ts`
- Create: `apps/menubar/README.md`
- Test: `apps/menubar/src/daemon-control.test.ts`

- [ ] Build a minimal menubar process that starts and stops daemons through the Plan 01 supervisor.
- [ ] Show running local files and relay host status.
- [ ] Show share state summary for relay-hosted files: view link count, edit link count, active session count, and revoked/expired warning count.
- [ ] Provide menu actions: Create/copy new view link, Create/copy new edit link, Open Share drawer.
- [ ] Add menu items: Open in Browser, Pause Sync, Resume Sync, Stop Hosting, Quit MarkLab.
- [ ] Do not embed a native Markdown editor.
- [ ] Do not add a document workspace/sidebar.
- [ ] Store recent local file paths locally only.

Acceptance criteria:

- The CLI path remains the primary product path.
- The menubar only manages daemon lifecycle and status.
- The menubar uses the same app-support registry, stop commands, and local daemon token model as Plan 01.
- The menubar reads relay share state through the same Plan 02 share-state contract and does not create a separate link store.
- The menubar never reconstructs share URLs from token hashes; it creates a fresh relay grant when the user asks to copy a link and no raw URL is available.
- Quitting the menubar cleanly stops hosted relay sessions unless the user explicitly leaves a background daemon running.

## Task 7: Docker-Compatible Hosted Relay Packaging

**Files:**

- Create: `infra/docker/api.Dockerfile`
- Create: `infra/docker/web.Dockerfile`
- Create: `infra/docker/docker-compose.prod-smoke.yml`
- Create: `infra/fly/fly.toml.example`
- Create: `infra/fly/README.md`
- Modify: `apps/api/package.json`
- Modify: `apps/web/package.json`

- [ ] Build API image from workspace with production dependencies.
- [ ] Build web static assets and serve them behind the chosen production web process.
- [ ] Include health checks for API and relay websocket readiness.
- [ ] Provide a local production-smoke compose file with Postgres, API, and web.
- [ ] Provide a Fly-style example config that maps the env contract from Task 1.
- [ ] Production-smoke compose starts from an empty Postgres volume and applies the relay schema/migrations before health checks pass.
- [ ] `/healthz` reports database schema readiness separately from process liveness.
- [ ] Ensure env names match Task 1 exactly.

Acceptance criteria:

- `docker compose -f infra/docker/docker-compose.prod-smoke.yml up --build` starts a local production-like stack.
- `/healthz` reports database and relay readiness.
- A relay websocket smoke client can connect and receive `host_offline` when no host daemon is connected.
- The Fly example contains no secrets and uses documented env variable names only.
- Empty-database production smoke proves schema readiness before share/join smoke begins.

## Task 8: Observability And Operations

**Files:**

- Create: `apps/api/src/relay/relay-observability.ts`
- Modify: `apps/api/src/relay/relay-server.ts`
- Create: `docs/production/relay-ops.md`
- Test: `apps/api/src/relay/relay-observability.test.ts`

- [ ] Add structured logs for relay room lifecycle, grant validation, host lease changes, write rejection, and revocation.
- [ ] Add counters for connected rooms, connected sessions, rejected writes, expired host leases, revoked sessions, and oversized messages.
- [ ] Ensure host file write failure or timeout never increments `sharedRevision` and never broadcasts accepted state.
- [ ] Ensure deploy drain stops new write admission and either waits for in-flight host acknowledgements or rejects them before websocket shutdown.
- [ ] Add a human-readable relay ops runbook.
- [ ] Document how to drain deploys without silently accepting edits.
- [ ] Document how to investigate "Host offline" reports.

Acceptance criteria:

- Logs never include raw share tokens or local file contents.
- Operators can answer: how many rooms are online, how many hosts are offline, and why writes are being rejected.
- Deploy drain sets rooms to host-offline or reconnecting before websocket shutdown.
- Host file write failure leaves `sharedRevision` unchanged and sends no accepted broadcast.

## Task 9: Privacy And User Documentation

**Files:**

- Create: `docs/production/privacy-and-storage.md`
- Create: `docs/production/local-daemon-distribution.md`
- Modify: `README.md`

- [ ] Explain that local files remain canonical for daemon users.
- [ ] Explain what the hosted relay stores: grants, sessions, metadata, ephemeral relay state, logs without document content.
- [ ] Explain what the local daemon stores: local metadata, snapshots, conflicts, recent files.
- [ ] Explain host-online behavior in plain language.
- [ ] Explain install options: npm alpha, future package manager, optional menubar.
- [ ] Explain that AI agents should edit local files, not call hosted write APIs.

Acceptance criteria:

- A new user understands whether closing the terminal stops hosting.
- A collaborator understands that view links are browser-only.
- A coder can run `marklab join <edit-link> --dir ./docs --name README.md` without reading source code.

## Verification

Minimum automated checks:

```text
npx -y pnpm@10.0.0 typecheck
npx -y pnpm@10.0.0 test apps/api/src/config/env.test.ts apps/api/src/relay/relay-limits.test.ts apps/api/src/relay/relay-room-service.test.ts apps/api/src/relay/relay-server.test.ts apps/api/src/relay/relay-observability.test.ts
npx -y pnpm@10.0.0 test apps/cli/marklab-cli.test.mjs apps/cli/relay-config.test.mjs apps/cli/package-install-smoke.test.mjs
npx -y pnpm@10.0.0 --filter @marklab/cli pack --dry-run
npx -y pnpm@10.0.0 --filter @marklab/web exec playwright test tests/relay-collaboration.spec.ts tests/local-conflict-review.spec.ts
if [ -d apps/menubar ]; then npx -y pnpm@10.0.0 test apps/menubar/src/daemon-control.test.ts; fi
git diff --check
```

Production smoke:

```text
docker compose -f infra/docker/docker-compose.prod-smoke.yml down -v
docker compose -f infra/docker/docker-compose.prod-smoke.yml up --build
marklab share README.md --relay http://127.0.0.1:<api-port>
marklab join <edit-link> --dir /tmp/marklab-bob --name README.md
```

Manual acceptance:

```text
1. Install or run the CLI through the documented alpha channel.
2. Run marklab share README.md.
3. Confirm the CLI says whether closing the terminal stops hosting.
4. Open an edit link in a browser and edit while host daemon is online.
5. Confirm host README.md changes.
6. Stop host daemon and confirm browser edit is rejected as Host offline.
7. Restart host daemon and confirm editing resumes.
8. Run marklab join <edit-link> --dir ./tmp-collab --name README.md.
9. Confirm the new local file is created and syncs while online.
10. Open a view link and confirm it is browser-only.
11. Revoke a link and confirm only sessions using that link disconnect.
12. If menubar is implemented, start/stop through menubar and confirm `marklab status` sees the same daemon registry.
13. If menubar is implemented, confirm menubar share summary matches `marklab share-state --json`.
```

## Gstack Plan Review Closure

Gstack `plan-eng-review` returned `PASS_WITH_CONCERNS`; the P1/P2 findings have been folded into this revision.

Review concerns addressed:

- `@marklab/cli` packaging is now an explicit Task 5 deliverable, including clean install smoke.
- `marklab join` fails closed while host is offline and must not touch the target path.
- host accepted-update acknowledgement requires durable host file write and unchanged failure semantics in Plan 02.
- non-empty local mirror join starts no watcher and mutates no file before explicit user choice.
- web E2E files are owned by tasks, not only referenced in verification.
- production smoke starts from an empty database and proves schema readiness.

Remaining implementation review focus:

- production server config is not vague;
- local daemon distribution does not accidentally become a native editor rewrite;
- Plan 04 does not create a second daemon lifecycle separate from Plan 01;
- hosted relay still is not canonical document storage;
- host-online semantics are visible to users;
- view links cannot create local mirrors;
- production observability is enough to debug relay failures;
- deployment drain cannot silently drop accepted edits;
- CLI install and menubar scope are not overbuilt.
