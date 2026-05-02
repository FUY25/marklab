# MarkLab

MarkLab is a local-first Markdown collaboration tool.

The product idea is simple: keep the real document as a normal `.md` file on disk, then add live browser editing, share links, local mirrors, conflict review, and AI-agent coordination around that file. No cloud document workspace. No hosted document database. No special editor lock-in.

If an AI agent, VS Code, Typora, Vim, or a human edits the Markdown file directly, MarkLab treats that file change as the product event.

## Current Alpha

The current alpha is the Plan 04A hosted-relay release.

- Public CLI package: `@marklab/cli@0.1.0-alpha.5`
- npm dist tag: `latest`
- Hosted relay: [https://marklab-relay-alpha.fly.dev](https://marklab-relay-alpha.fly.dev)
- Fly.io app: `marklab-relay-alpha`
- Fly.io region: Singapore, `sin`
- Database: Neon Postgres
- Neon region: AWS Asia Pacific 1 Singapore, `aws-ap-southeast-1`
- Relay websocket: `wss://marklab-relay-alpha.fly.dev/relay`

The hosted service is live relay infrastructure. It stores relay metadata and ephemeral sync state. It is not the canonical document store.

## Quick Start

Start persistent watching in the background:

```sh
npx -y @marklab/cli open README.md --background
npx -y @marklab/cli status
```

Create a hosted edit link:

```sh
npx -y @marklab/cli create-link README.md --role edit
```

The packaged alpha CLI defaults to the hosted relay at `marklab-relay-alpha.fly.dev`, so normal users do not need to export public relay URLs before sharing.

For a temporary foreground share, use:

```sh
npx -y @marklab/cli share README.md
```

Foreground sharing stops when that terminal closes. Use it for quick tests, not persistent hosting.

For a collaborator who wants a local file mirror that keeps listening in the background, send the edit link plus this one-liner:

```sh
npx -y @marklab/cli join '<edit-link>' --pick-dir --background
```

That command installs/runs the CLI through `npx`, opens a folder picker, creates the shared Markdown file with the host filename, starts the local mirror daemon, opens the local browser view, and returns after the background sync starts.

## Product Model

MarkLab has one source of truth for host-side collaboration: the local Markdown file.

- The host local `.md` file is canonical.
- Browser edits are written back to that local file.
- AI agents edit the local file directly.
- Local mirrors created with `marklab join` are local files, not cloud documents.
- The relay coordinates rooms, links, sessions, permissions, host leases, revisions, hashes, and ephemeral Yjs state.
- Relay cache expiry is not document deletion.
- Stop sharing does not delete local files.
- Revoking a link removes access for that grant only.
- If the host file disappears, sync pauses and remote writes reject. MarkLab does not silently recreate the file.

View links are browser-only and read-only. Edit links can be used in the browser or with `marklab join`.

## Architecture

```text
Host machine
  README.md                         canonical Markdown file
  marklab local daemon              watches disk, owns local token, talks to relay
  local browser editor              http://127.0.0.1:<port>/local#token=...

Hosted relay on Fly.io
  Express API                       health, relay access, share-state routes
  WebSocket relay                   /relay
  static web app                    /relay/<room>
  Neon Postgres                     relay metadata and ephemeral state TTL

Collaborators
  browser edit link                 live online editing while host is online
  browser view link                 read-only, no local mirror creation
  marklab join <edit-link>          optional local Markdown mirror
```

The local browser URL is private. It looks like:

```text
http://127.0.0.1:5175/local#token=...
```

Do not share it. It contains local daemon access in the URL fragment.

The relay URL is shareable. It looks like:

```text
https://marklab-relay-alpha.fly.dev/relay/<room>?token=...
```

Relay links never expose the local daemon token or localhost URL.

## What Is Implemented

Plan 01 through Plan 04A are the current implemented product path:

- Local file open/sync from disk to browser and browser to disk.
- Background daemon lifecycle with `marklab status`, `marklab stop <file>`, and `marklab stop --all`.
- Local snapshots, versions, and conflict review.
- AI-agent commands for status, wait, save-version, conflict inspection, and instructions.
- Hosted relay rooms, grants, sessions, host leases, revision/hash tracking, and cleanup metadata.
- Production env validation, public URL construction, allowed origins, WebSocket limits, and `/healthz` readiness checks.
- Fly.io deployment packaging and Docker-compatible production smoke files.
- npm alpha CLI package, published as `@marklab/cli`.
- Hosted edit links and view links.
- `marklab join` local mirror flow, including `--pick-dir --background`.
- Hosted browser presence for online editors: name, cursor, and color are relayed live and not persisted.
- Lifecycle safety for host offline, revoked links, relay expiry, and missing local files.

## What Is Not In This Alpha

These are intentionally not part of Plan 04A:

- No native Markdown editor.
- No document workspace/sidebar.
- No hosted document storage.
- No hosted AI write/edit API.
- No Homebrew distribution yet.
- No signed standalone app yet.
- No menubar manager yet.
- No hosted Share/Versions/Conflict controls on the relay edit page yet.

The next planned polish bucket is Plan 04B. It may add hosted web Share, Versions, and Conflict Review controls, but those controls must still use the existing local canonical file/version path. The hosted relay should coordinate. It should not become the document or version store.

## Common Workflows

Host a file persistently in background mode and create links:

```sh
npx -y @marklab/cli open README.md --background
npx -y @marklab/cli create-link README.md --role edit
npx -y @marklab/cli create-link README.md --role view
```

Host a file temporarily in foreground mode:

```sh
npx -y @marklab/cli share README.md
```

Foreground sharing stops when that terminal closes.

Join an edit link as a local mirror:

```sh
npx -y @marklab/cli join '<edit-link>' --pick-dir --background
```

Check share state:

```sh
npx -y @marklab/cli share-state README.md --json
```

Create a safety snapshot before a large local or AI edit:

```sh
npx -y @marklab/cli save-version README.md --message "Before broad edit" --json
```

Wait for sync after editing the file directly:

```sh
npx -y @marklab/cli wait README.md --synced --timeout 10000 --json
```

Inspect conflict state:

```sh
npx -y @marklab/cli conflict README.md --json
```

## For AI Agents

Codex, Claude Code, Cursor, and similar agents should treat the local Markdown file as the write surface.

Use MarkLab for coordination:

- `marklab status <file> --json`
- `marklab save-version <file> --message "Before AI edit" --json`
- `marklab wait <file> --synced --timeout 10000 --json`
- `marklab conflict <file> --json`
- `marklab create-link <file> --role edit --json`
- `marklab revoke-link <file> <grant-id> --json`

Do not mutate hosted Yjs state, database rows, or relay internals directly. There is no supported hosted AI write path in the alpha.

Install agent instructions into a repo:

```sh
npx -y @marklab/cli agent instructions --target codex
npx -y @marklab/cli agent install --target codex --write AGENTS.md
```

## Operations

The Plan 04A hosted deployment uses one Fly machine for the alpha because relay WebSocket sessions and immediate revoke disconnects are process-local. Scaling beyond one machine requires sticky routing or shared relay fanout.

Runtime defaults:

```text
MARKLAB_REQUIRE_AUTH=true
MARKLAB_PUBLIC_WEB_URL=https://marklab-relay-alpha.fly.dev
MARKLAB_PUBLIC_API_URL=https://marklab-relay-alpha.fly.dev
MARKLAB_PUBLIC_RELAY_WS_URL=wss://marklab-relay-alpha.fly.dev/relay
MARKLAB_ALLOWED_ORIGINS=https://marklab-relay-alpha.fly.dev
MARKLAB_RELAY_EPHEMERAL_TTL_SECONDS=86400
MARKLAB_RELAY_HOST_LEASE_SECONDS=30
MARKLAB_RELAY_MAX_ROOM_CONNECTIONS=32
MARKLAB_RELAY_MAX_MESSAGE_BYTES=1048576
```

The npm CLI includes the alpha hosted relay URLs by default. Use the env vars above only for operators, custom deployments, or self-hosted relay testing. To force loopback relay URLs during local development, set:

```sh
MARKLAB_RELAY_MODE=development
```

Health check:

```sh
curl https://marklab-relay-alpha.fly.dev/healthz
```

`/healthz` separates process liveness from database readiness, schema readiness, and relay readiness.

Operator docs:

- [Fly.io And Neon Alpha Relay Setup](infra/fly/README.md)
- [Hosted Relay Operations](docs/production/relay-ops.md)
- [Privacy And Storage](docs/production/privacy-and-storage.md)
- [Local Daemon Distribution](docs/production/local-daemon-distribution.md)

User docs:

- [MarkLab Alpha User Guide](docs/product/marklab-alpha-user-guide.md)
- [Local URL vs Relay URL](docs/product/local-url-vs-relay-url.md)
- [Local-First User Journeys](docs/product/local-first-user-journeys.md)
- [AI Agent Guide](docs/agent/marklab-agent-guide.md)

## Development

From this repository:

```sh
npx -y pnpm@10.0.0 install
npx -y pnpm@10.0.0 typecheck
npx -y pnpm@10.0.0 test
```

Run the local CLI from the repo:

```sh
npx -y pnpm@10.0.0 marklab open README.md
```

Run focused Plan 04A checks:

```sh
npx -y pnpm@10.0.0 test apps/api/src/config/env.test.ts apps/api/src/relay/relay-limits.test.ts apps/api/src/relay/relay-room-service.test.ts apps/api/src/relay/relay-server.test.ts apps/api/src/relay/relay-observability.test.ts
npx -y pnpm@10.0.0 test apps/cli/marklab-cli.test.mjs apps/cli/relay-config.test.mjs apps/cli/package-install-smoke.test.mjs
npx -y pnpm@10.0.0 --filter @marklab/cli pack --dry-run
npx -y pnpm@10.0.0 --filter @marklab/web exec playwright test tests/relay-collaboration.spec.ts tests/local-conflict-review.spec.ts
```

## Plans And Historical Reference

Active implementation plans:

- [Plan 01: Local File Sync MVP](plans/01_local_file_sync_mvp_plan.md)
- [Plan 02: Local Collaboration Relay MVP](plans/02_local_collaboration_relay_mvp_plan.md)
- [Plan 03: Reconnect Conflict Review](plans/03_reconnect_conflict_review_plan.md)
- [Plan 04: Hosted Relay Production And Distribution](plans/04_hosted_relay_production_and_distribution_plan.md)
- [Plan 05: AI Agent Operating Layer](plans/05_ai_agent_operating_layer_plan.md)
- [Plan 06: Legacy Cloud AI Write Cleanup](plans/06_legacy_cloud_ai_write_cleanup_plan.md)

Root files named `00_*.md` through `09_*.md` and files under `plans/Archive/cloud-first-reference/` are historical cloud-first reference material. They explain prior Milkdown/Yjs decisions, but the current implementation path is local-first.
