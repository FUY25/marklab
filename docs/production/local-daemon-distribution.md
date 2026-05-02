# Local Daemon Distribution

Plan 04A distribution is an alpha CLI flow. It does not include Homebrew distribution, a signed standalone app, a menubar manager, a native Markdown editor, or a workspace/sidebar product.

## Alpha Command Shape

The supported alpha commands are:

```bash
npx -y @marklab/cli open README.md
npx -y @marklab/cli share README.md
npx -y @marklab/cli join <edit-link> --dir ./docs --name README.md
```

If the npm package name changes before alpha, update README examples, CLI docs, smoke tests, and release notes together.

## Product Model

The local Markdown file is canonical. The daemon watches and writes that file. The browser UI is an editor surface over the daemon. The hosted relay coordinates identity, permissions, host-online state, and websocket routing only when sharing is enabled.

There is no Plan 04A cloud document workspace. Do not add:

- Homebrew install docs as implemented behavior;
- signed app install docs;
- native Markdown editor docs;
- menubar lifecycle docs;
- hosted AI write/edit API docs;
- second restore/version/collaboration paths.

## Foreground And Background Hosting

Foreground hosting stays attached to the terminal:

```bash
marklab open README.md
marklab share README.md
```

Closing that terminal stops the daemon and makes hosted relay sharing go offline.

Background hosting uses the Plan 01 daemon supervisor:

```bash
marklab open README.md --background
marklab status README.md
marklab stop README.md
marklab stop --all
```

Background mode must reuse the existing daemon registry and metadata paths. It must not create a second supervisor, workspace database, or native app lifecycle.

## Join Behavior

Exact target path:

```bash
marklab join <edit-link> ./README.md
```

Directory with relay-derived safe filename:

```bash
marklab join <edit-link> --dir ./docs
```

Directory with exact filename:

```bash
marklab join <edit-link> --dir ./docs --name shared-notes.md
```

For AI agents, this is the supported collaboration path:

```bash
marklab join <edit-link> --dir ./docs --name README.md
```

Agents then edit the local file directly and use MarkLab commands to check status, wait for sync, save versions, and inspect conflicts.

## Host-Offline Behavior

Host online means the daemon is running and connected. If the host is offline:

- browser edit links must not commit writes;
- local mirror joins must not create files or start watchers before validating access;
- agents must not bypass the relay with hosted content mutation APIs;
- existing local files must remain unchanged unless the user explicitly resolves a pending join/conflict.

## Future Distribution

Homebrew, signed standalone packaging, auto-update behavior, and a menubar daemon manager are future Plan 04B surfaces. They can be designed after Plan 04A proves the alpha CLI and hosted relay path.
