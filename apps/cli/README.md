# MarkLab CLI

Alpha CLI package for running MarkLab's local-first Markdown collaboration flow.

```sh
npx -y @marklab/cli open README.md
npx -y @marklab/cli share README.md
npx -y @marklab/cli join '<edit-link>' --pick-dir --background
```

## Requirements

- Node.js 20.19 or newer, Node.js 22.12 or newer, or Node.js 24 or newer.
- A modern browser.
- For this alpha package, local `open`, `share`, and `join` daemon commands still expect the package-managed MarkLab API and web app runtime used by this repository. The packed CLI is verified to parse commands and print help from a clean install without a repository checkout.

Ordinary collaborators using a hosted edit link do not need Postgres, Docker, pnpm, Git, or a specific Markdown editor.

## Commands

```sh
marklab open <file.md>
marklab open <file.md> --background
marklab share <file.md>
marklab join <edit-link> <file.md>
marklab join <edit-link> --pick-dir --background
marklab join <edit-link> --dir ./docs --create-dir --background
marklab status
marklab stop <file.md>
marklab stop --all
```

Use `marklab --help`, `marklab open --help`, `marklab share --help`, or `marklab join --help` for command help.

## Host Online Behavior

Host online means the MarkLab daemon is running and connected.

When `marklab share <file.md>` runs in the foreground, closing that terminal stops hosting. Closing the browser tab does not stop hosting as long as the daemon process is still running. If you use `marklab open <file.md> --background` and then create a share link, hosting continues after the terminal command exits until you run `marklab stop <file.md>` or `marklab stop --all`.

Browser edit and view links work without installing MarkLab. A pure web link cannot install or run a local CLI, create local files, or inspect whether local software is available, because browsers do not have that access. The current safe alpha path is one relay link plus a copyable one-line `npx` command for collaborators who want a local mirror.

Edit links can be used in the browser or with `marklab join`. View links are browser-only and cannot create local mirrors. To choose the destination folder with a system dialog and create a background local Markdown mirror, use an edit link:

```sh
marklab join <edit-link> --pick-dir --background
```

The collaborator can also type a folder instead:

```sh
marklab join <edit-link> --dir ./docs --create-dir --background
```

The collaborator chooses the destination folder; MarkLab uses the host file name from the edit link. Background join opens the local browser URL, then returns after the mirror daemon starts. Omit `--background` for foreground join and keep the terminal open while you want the mirror to sync. Stop a background mirror with `marklab stop ./docs/README.md`, or stop every local MarkLab daemon with `marklab stop --all`.

`marklab join` rejects view links and host-offline links before creating directories, writing files, starting a watcher, or connecting a daemon.

## Relay URL Configuration

Development defaults use local loopback URLs:

```text
MARKLAB_PUBLIC_WEB_URL=http://127.0.0.1:<web-port>
MARKLAB_PUBLIC_API_URL=http://127.0.0.1:<api-port>
MARKLAB_PUBLIC_RELAY_WS_URL=ws://127.0.0.1:<api-port>/relay
```

Production share links should be built with all three public URLs:

```sh
MARKLAB_PUBLIC_WEB_URL=https://marklab-relay-alpha.fly.dev \
MARKLAB_PUBLIC_API_URL=https://marklab-relay-alpha.fly.dev \
MARKLAB_PUBLIC_RELAY_WS_URL=wss://marklab-relay-alpha.fly.dev/relay \
marklab share README.md
```

When public URLs are configured, MarkLab requires all three values together and rejects loopback public URLs. Production relay WebSocket URLs must use `wss://`.
