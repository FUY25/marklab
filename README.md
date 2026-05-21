# MarkLab

MarkLab is a local-first Markdown collaboration tool.

The product model is still simple: the user's `.md` file on disk remains the local working copy, while MarkLab adds live `/collab` editing, native app sharing, browser sharing, conflict review, and agent-friendly file ingestion around that file.

## Current Pilot

The current pilot is the hosted control-plane/Y-Sweet native path. The old local daemon route has been removed from active build, test, and CLI paths.

- Native app: `apps/marklab-macos`
- Hosted pilot target: `https://marklab-relay-alpha.fly.dev`
- Browser collaborator route: `/collab?docId=...&branchId=...&token=...&mode=edit|view`
- Control plane: `/api/auth/*`, `/api/workspaces/*`, `/api/docs/*`, access grants, and collab sessions
- Provider: Y-Sweet routes proxied at the API root, for example `/d/<providerDocId>/ws/<providerDocId>`
As of May 18, 2026, `marklab-relay-alpha.fly.dev` is deployed with the new API/control-plane/Y-Sweet stack on Fly.io, backed by Neon and a Fly volume for provider data. Public health should include `ok: true`, `schema.ready: true`, `provider.ready: true`, and `provider.storeReady: true`.

## Pilot Workflow

Launch MarkLab.app with a hosted control-plane session:

```sh
MARKLAB_CONTROL_PLANE_API_URL=https://marklab-relay-alpha.fly.dev \
MARKLAB_PUBLIC_WEB_URL=https://marklab-relay-alpha.fly.dev \
MARKLAB_USER_TOKEN=<ml_user_...> \
MARKLAB_WORKSPACE_ID=<workspace-id> \
swift run --package-path apps/marklab-macos MarkLabApp
```

For the local operator pilot on this machine, the seeded values are stored in the ignored `.env.marklab-pilot` file:

```sh
set -a
source ./.env.marklab-pilot
set +a
swift run --package-path apps/marklab-macos MarkLabApp
```

Broad external pilots still need a real login path, normally OIDC via `MARKLAB_OIDC_*`. Production disables `/api/auth/dev-login`, so do not rely on dev auth for arbitrary pilot users.

Host:

1. Open a local Markdown file in MarkLab.app.
2. Click `Start Sharing`.
3. Use `Create Edit Link` or `Create View Link`.
4. The created link is copied to the clipboard.
5. Use `Show Collaboration` to manage active access links, active human collaborators, and local sync state.
6. Use `Stop Sharing` to flush local projection, revoke active links known to this app session, and return the window to local-only editing.

Browser collaborator:

1. Open the edit link in a browser.
2. Edit in `/collab`.
3. Presence and cursor state are shared with the app while connected.

App collaborator:

1. Open the same edit link with MarkLab.app, or run:

```sh
npx -y @marklab/cli join 'https://<host>/collab?docId=...&branchId=...&token=...&mode=edit'
```

2. MarkLab.app validates the link.
3. Choose the destination folder.
4. The local file uses the shared document name.
5. The app binds that file to the shared document and coedits through the same `/collab` provider path.

View links are browser-only and must not mount an editable editor.

## Save Model

Local-only editing behaves like a normal document editor by default: edits live in the app until the user saves with `Cmd+S` or the standard save command.

The native document toolbar includes `Local Autosave`. When enabled, local-only edits are written to the `.md` file after a short debounce, and `Cmd+S` still flushes immediately. This setting is only for local-only windows; it does not write through shared-mode projection.

Shared editing has two flows:

- Browser/provider changes are projected back to the local `.md` file by the native app with a short debounce.
- `Cmd+S` while sharing flushes any pending projection immediately.

If the local disk file and the provider state both diverge, MarkLab pauses the write and opens conflict review instead of silently overwriting either side.

Realtime sync is not the same thing as version control. The API has version endpoints for manual saves, autosaves, listing, and restore, but the new native relay UI does not yet expose a complete hosted Versions panel. For important pilot files, keep Git, Time Machine, or another external backup/version history until the native hosted Versions UI is finished.

## Local Development

Install and verify:

```sh
npx -y pnpm@10.0.0 install
npx -y pnpm@10.0.0 typecheck
npx -y pnpm@10.0.0 test
swift test --package-path apps/marklab-macos
```

Build the browser collaborator app:

```sh
npx -y pnpm@10.0.0 --filter @marklab/collab-web build
```

Package the native app:

```sh
npx -y pnpm@10.0.0 --filter @marklab/marklab-macos package:app
npx -y pnpm@10.0.0 --filter @marklab/marklab-macos verify:package
```

Run the native/browser relay smoke:

```sh
npx -y pnpm@10.0.0 --filter @marklab/marklab-macos smoke:native-browser
```

Manual pilot setup and acceptance steps are in:

- [New Relay/Y-Sweet Pilot Runbook](docs/manual-acceptance/new-relay-pilot.md)
- [MarkLab Alpha User Guide](docs/product/marklab-alpha-user-guide.md)

## Hosted Pilot Infra

The current hosted pilot shape is Fly.io plus Neon:

- Fly.io hosts the API, `/collab` static app, control-plane routes, and API-root Y-Sweet provider proxy.
- Neon stores users, workspaces, documents, branches, access grants, versions, and session metadata.
- A Fly volume stores Y-Sweet provider data.

`marklab-relay-alpha.fly.dev` has been redeployed to the new stack. Verify it before a pilot session:

```sh
curl -fsS https://marklab-relay-alpha.fly.dev/healthz | jq .
fly status -a marklab-relay-alpha
fly checks list -a marklab-relay-alpha
fly volumes list -a marklab-relay-alpha
```

A healthy deployment must expose `/healthz` with database, schema, and provider readiness:

```json
{
  "ok": true,
  "schema": {
    "ready": true,
    "missing": []
  },
  "provider": {
    "required": true,
    "ready": true,
    "storeReady": true
  }
}
```

For launch operations, apply `apps/api/src/db/schema.sql` to Neon before a health-gated Fly deploy, then run the strict smoke with an authenticated pilot owner:

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f apps/api/src/db/schema.sql
NO_COLOR=1 fly deploy -a marklab-relay-alpha --local-only --depot=false --wait-timeout 10m --yes
MARKLAB_BOOTSTRAP_EMAIL=<pilot-owner@example.com> node scripts/marklab-bootstrap-alpha-user.mjs
MARKLAB_ALPHA_BASE_URL=https://marklab-relay-alpha.fly.dev \
MARKLAB_ALPHA_REQUIRE_AUTH_SMOKE=1 \
MARKLAB_USER_TOKEN=<ml_user_...> \
MARKLAB_WORKSPACE_ID=<workspace-id> \
node scripts/marklab-alpha-smoke.mjs
```

If Fly remote builders hang at `Waiting for depot builder` or `Waiting for remote builder`, use the documented local Docker deploy path:

```sh
open -a Docker
NO_COLOR=1 fly deploy -a marklab-relay-alpha --local-only --depot=false --wait-timeout 10m --yes
```

The Docker build depends on the repo-root `.dockerignore`; keep it updated when new large local-only directories are added.

## CLI Status

The CLI now exposes only the current MarkLab.app + hosted `/collab` pilot commands:

```sh
marklab doctor --json
marklab open README.md
marklab share README.md
marklab join 'https://<host>/collab?docId=...&branchId=...&token=...&mode=edit'
marklab status README.md --json
marklab wait README.md --synced --json
marklab conflict README.md --json
```

`open` and `share` route to MarkLab.app; `share` asks the app to create current hosted edit/view links. The app owns Start Sharing, workspace-owned document creation, and access-link creation. `join` opens a `marklab://join?...` deep link for MarkLab.app. View links are rejected because they are browser-only. `status`, `wait`, and `conflict` read native MarkLab.app support files so agents can coordinate with the local `.md` without using provider internals.

## Product Docs

- [App Design Doc](docs/appdesigndoc.md)
- [Alpha User Guide](docs/product/marklab-alpha-user-guide.md)
- [Local-First User Journeys](docs/product/local-first-user-journeys.md)
- [Local URL vs Relay URL](docs/product/local-url-vs-relay-url.md)
- [Privacy And Storage](docs/production/privacy-and-storage.md)
- [Hosted Relay Operations](docs/production/relay-ops.md)
- [Alpha Launch Runbook](docs/production/alpha-launch-runbook.md)
- [Agent Guide](docs/agent/marklab-agent-guide.md)

## Archived Plans

Files under `docs/Archive/` are historical planning and design material. They are useful reference, but `docs/appdesigndoc.md`, the Plan 6 packaging doc, and the manual acceptance runbook describe the current relay/native pilot.
