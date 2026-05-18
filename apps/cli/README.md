# MarkLab CLI

CLI helper package for MarkLab. The current non-legacy command surface routes local files and hosted `/collab` edit links into MarkLab.app, diagnoses the hosted pilot, and lets agents inspect native sync/conflict state. The old local-daemon Markdown mirror commands remain archived compatibility commands.

The new MarkLab pilot uses MarkLab.app with the hosted `/collab` control-plane/Y-Sweet path:

```sh
npx -y @marklab/cli doctor --json
npx -y @marklab/cli open README.md
npx -y @marklab/cli share README.md
npx -y @marklab/cli join 'https://<host>/collab?docId=...&branchId=...&token=...&mode=edit'
npx -y @marklab/cli status README.md --json
npx -y @marklab/cli wait README.md --synced --json
npx -y @marklab/cli conflict README.md --json
```

`open` and `share` open the file in MarkLab.app. `share` does not create hidden daemon relay links; the native app owns Start Sharing, workspace-owned document creation, and access-link creation. `join` opens `marklab://join?...` so MarkLab.app can ask where to create or attach the local Markdown file. View links stay browser-only.

The legacy local-daemon CLI commands are disabled by default. For archived compatibility testing only, opt in explicitly:

```sh
MARKLAB_ENABLE_LEGACY_CLI=1 marklab status
```

```sh
MARKLAB_ENABLE_LEGACY_CLI=1 npx -y @marklab/cli open README.md --background
MARKLAB_ENABLE_LEGACY_CLI=1 npx -y @marklab/cli create-link README.md --role edit
MARKLAB_ENABLE_LEGACY_CLI=1 npx -y @marklab/cli join '<legacy-relay-link>' --pick-dir --background
```

## Requirements

- Node.js 20.19 or newer, Node.js 22.12 or newer, or Node.js 24 or newer.
- A modern browser.
- The npm package includes the CLI runtime for hosted `/collab` link opening plus archived compatibility commands. Developers working from the repository checkout can still use pnpm for local development.

Ordinary collaborators using a hosted edit link do not need Postgres, Docker, pnpm, Git, or a specific Markdown editor.

## Commands

```sh
marklab join <https://.../collab?...mode=edit>
marklab open <file.md>
marklab share <file.md>
marklab status <file.md> --json
marklab wait <file.md> --synced --json
marklab conflict <file.md> --json
marklab doctor --json
```

Archived compatibility commands require `MARKLAB_ENABLE_LEGACY_CLI=1`:

```sh
marklab open <file.md> --background
marklab create-link <file.md> --role edit
marklab create-link <file.md> --role view
marklab join <legacy-relay-link> <file.md>
marklab join <legacy-relay-link> --pick-dir --background
marklab join <legacy-relay-link> --dir ./docs --create-dir --background
marklab stop <file.md>
marklab stop --all
```

Use `marklab --help`, `marklab open --help`, `marklab share --help`, or `marklab join --help` for command help.

## Archived Daemon Behavior

The following behavior applies only when `MARKLAB_ENABLE_LEGACY_CLI=1` is set.

Host online means the archived MarkLab daemon is running and connected.

Use persistent background hosting for normal collaboration:

```sh
marklab open <file.md> --background
marklab create-link <file.md> --role edit
```

Hosting continues after the terminal command exits until you run `marklab stop <file.md>` or `marklab stop --all`. Closing the browser tab does not stop hosting as long as the daemon process is still running.

`marklab share <file.md>` is temporary foreground sharing. Closing that terminal stops hosting, so use it for quick tests rather than persistent collaboration.

Browser edit and view links work without installing MarkLab. A pure web link cannot install or run local software, create local files, or inspect whether MarkLab.app is available, because browsers do not have that access. The current safe alpha path is one hosted `/collab` edit link plus optional native app opening through `marklab join`.

```sh
marklab join 'https://<host>/collab?docId=...&branchId=...&token=...&mode=edit'
```

The app then prompts for the local Markdown file. It validates the link before creating a file and refuses view links.

The archived legacy relay mirror path is still available only when explicitly enabled.

Legacy edit links can be used in the browser or with `marklab join`. View links are browser-only and cannot create local mirrors. To choose the destination folder with a system dialog and create a background local Markdown mirror, use an edit link:

```sh
MARKLAB_ENABLE_LEGACY_CLI=1 marklab join <legacy-relay-link> --pick-dir --background
```

The collaborator can also type a folder instead:

```sh
MARKLAB_ENABLE_LEGACY_CLI=1 marklab join <legacy-relay-link> --dir ./docs --create-dir --background
```

The collaborator chooses the destination folder; MarkLab uses the host file name from the edit link. Background join opens the local browser URL, then returns after the mirror daemon starts. Omit `--background` for foreground join and keep the terminal open while you want the mirror to sync. Stop a background mirror with `marklab stop ./docs/README.md`, or stop every local MarkLab daemon with `marklab stop --all`.

`marklab join` rejects view links and host-offline links before creating directories, writing files, starting a watcher, or connecting a daemon.

## Archived Relay URL Configuration

These variables apply to archived daemon compatibility commands:

```text
MARKLAB_PUBLIC_WEB_URL=https://marklab-relay-alpha.fly.dev
MARKLAB_PUBLIC_API_URL=https://marklab-relay-alpha.fly.dev
MARKLAB_PUBLIC_RELAY_WS_URL=wss://marklab-relay-alpha.fly.dev/relay
```

Normal new-pilot users do not need to set those variables. Operators and self-hosted testers can override the archived public relay URLs by setting all three values together:

```sh
MARKLAB_PUBLIC_WEB_URL=https://marklab-relay-alpha.fly.dev \
MARKLAB_PUBLIC_API_URL=https://marklab-relay-alpha.fly.dev \
MARKLAB_PUBLIC_RELAY_WS_URL=wss://marklab-relay-alpha.fly.dev/relay \
MARKLAB_ENABLE_LEGACY_CLI=1 \
marklab share README.md
```

When public URLs are configured, MarkLab requires all three values together and rejects loopback public URLs. Production relay WebSocket URLs must use `wss://`.

To force local loopback relay URLs while testing archived daemon behavior from this repository, set:

```sh
MARKLAB_RELAY_MODE=development
```
