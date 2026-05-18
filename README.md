# MarkLab

MarkLab is a local-first Markdown collaboration tool.

The product model is still simple: the user's `.md` file on disk remains the local working copy, while MarkLab adds live `/collab` editing, native app sharing, browser sharing, conflict review, and agent-friendly file ingestion around that file.

## Current Pilot

The current pilot is the new relay/Y-Sweet native path, not the old local daemon route.

- Native app: `apps/marklab-macos`
- Browser collaborator route: `/collab?docId=...&branchId=...&token=...&mode=edit|view`
- Control plane: `/api/auth/*`, `/api/workspaces/*`, `/api/docs/*`, access grants, and collab sessions
- Provider: Y-Sweet routes proxied at the API root, for example `/d/<providerDocId>/ws/<providerDocId>`
- Local daemon compatibility: archived and disabled by default

The old daemon CLI workflow can still be tested only by opting in with `MARKLAB_ENABLE_LEGACY_CLI=1`. Normal pilot users should use MarkLab.app and hosted `/collab` links.

## Pilot Workflow

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

Local-only editing behaves like a normal document editor: edits live in the app until the user saves with `Cmd+S` or the standard save command.

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

The intended external pilot shape is Fly.io plus Neon:

- Fly.io hosts the API, `/collab` static app, control-plane routes, and API-root Y-Sweet provider proxy.
- Neon stores users, workspaces, documents, branches, access grants, versions, and session metadata.
- A Fly volume stores Y-Sweet provider data.

The older `marklab-relay-alpha.fly.dev` deployment can be reused as the target service only after redeploying the new control-plane/Y-Sweet stack and applying the current schema. A healthy new-stack deployment must expose `/healthz` with provider readiness, including `provider.ready: true` and `provider.storeReady: true`.

## CLI Status

The CLI currently has one normal new-pilot command:

```sh
marklab join 'https://<host>/collab?docId=...&branchId=...&token=...&mode=edit'
```

That opens a `marklab://join?...` deep link for MarkLab.app. View links are rejected because they are browser-only.

The old daemon commands are archived compatibility commands and require explicit opt-in:

```sh
MARKLAB_ENABLE_LEGACY_CLI=1 marklab status
MARKLAB_ENABLE_LEGACY_CLI=1 marklab open README.md --background
MARKLAB_ENABLE_LEGACY_CLI=1 marklab create-link README.md --role edit
```

## Product Docs

- [App Design Doc](docs/appdesigndoc.md)
- [Alpha User Guide](docs/product/marklab-alpha-user-guide.md)
- [Local-First User Journeys](docs/product/local-first-user-journeys.md)
- [Local URL vs Relay URL](docs/product/local-url-vs-relay-url.md)
- [Archived Local Daemon Distribution](docs/production/local-daemon-distribution.md)
- [Privacy And Storage](docs/production/privacy-and-storage.md)
- [Hosted Relay Operations](docs/production/relay-ops.md)
- [Agent Guide](docs/agent/marklab-agent-guide.md)

## Archived Plans

Files under `docs/Archive/` are historical planning and design material. They are useful reference, but `docs/appdesigndoc.md`, the Plan 6 packaging doc, and the manual acceptance runbook describe the current relay/native pilot.
