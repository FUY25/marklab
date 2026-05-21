# MarkLab CLI

CLI helper package for the current MarkLab.app pilot. It routes local files and hosted `/collab` edit links into MarkLab.app, diagnoses the hosted control-plane/Y-Sweet target, and lets agents inspect native sync/conflict state.

```sh
npx -y @marklab/cli doctor --json
npx -y @marklab/cli open README.md
npx -y @marklab/cli share README.md --edit
npx -y @marklab/cli share README.md --view
npx -y @marklab/cli join 'https://<host>/collab?docId=...&branchId=...&token=...&mode=edit'
npx -y @marklab/cli status README.md --json
npx -y @marklab/cli wait README.md --synced --json
npx -y @marklab/cli conflict README.md --json
```

`open` opens the file in MarkLab.app. `share --edit` and `share --view` ask MarkLab.app to start or reuse hosted sharing, create the requested access link, copy it to the clipboard, and print it. `join` opens `marklab://join?...` or sends a native join request so MarkLab.app can create or attach the local Markdown file. View links stay browser-only.

The old local-daemon Markdown mirror, `/local`, and anonymous `/relay` CLI commands have been removed from this package. Use the current hosted `/collab` link shape for pilot work.

## Requirements

- Node.js 20.19 or newer, Node.js 22.12 or newer, or Node.js 24 or newer.
- MarkLab.app installed on macOS for native open/share/join actions.
- A hosted MarkLab control-plane URL for link creation and sync verification.

Ordinary browser collaborators using a hosted edit/view link do not need the CLI.

## Commands

```sh
marklab join <https://.../collab?...mode=edit>
marklab join <edit-link> <file.md>
marklab join <edit-link> --dir ./docs --create-dir
marklab open <file.md>
marklab share <file.md> --edit
marklab share <file.md> --view
marklab status <file.md> --json
marklab wait <file.md> --synced --json
marklab conflict <file.md> --json
marklab doctor --json
```

Use `marklab --help`, `marklab open --help`, `marklab share --help`, or `marklab join --help` for command help.

## Agent Contract

Agents edit the local Markdown file directly. They should not mutate hosted document state through a write API. After editing, agents can coordinate with:

```sh
marklab status README.md --json
marklab wait README.md --synced --json
marklab conflict README.md --json
```

If a conflict is open, resolve it in MarkLab.app before continuing.
