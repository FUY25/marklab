# MarkLab CLI

Alpha CLI package for running MarkLab's local-first Markdown collaboration flow.

```sh
npx -y @marklab/cli open README.md
npx -y @marklab/cli share README.md
npx -y @marklab/cli join <edit-link> --dir ./docs --name README.md
```

## Requirements

- Node.js 20 or newer.
- A modern browser.
- For this alpha package, local `open`, `share`, and `join` daemon commands still expect the package-managed MarkLab API and web app runtime used by this repository. The packed CLI is verified to parse commands and print help from a clean install without a repository checkout.

Ordinary collaborators using a hosted edit link do not need Postgres, Docker, pnpm, Git, or a specific Markdown editor.

## Commands

```sh
marklab open <file.md>
marklab open <file.md> --background
marklab share <file.md>
marklab join <edit-link> <file.md>
marklab join <edit-link> --dir ./docs --name shared-notes.md
marklab status
marklab stop <file.md>
marklab stop --all
```

Use `marklab --help`, `marklab open --help`, `marklab share --help`, or `marklab join --help` for command help.

## Host Online Behavior

Host online means the MarkLab daemon is running and connected.

When `marklab share <file.md>` runs in the foreground, closing that terminal stops hosting. Closing the browser tab does not stop hosting as long as the daemon process is still running. If you use `marklab open <file.md> --background` and then create a share link, hosting continues after the terminal command exits until you run `marklab stop <file.md>` or `marklab stop --all`.

View links are browser-only. To create a local Markdown mirror, use an edit link:

```sh
marklab join <edit-link> --dir ./docs --name README.md
```

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
