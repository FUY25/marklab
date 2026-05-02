# `marklab open README.md`

MarkLab is a local-first Markdown collaboration tool. The local `.md` file is canonical, and the browser editor is a live view/editor over that file.

AI agents work the same way as any other local tool: they edit the Markdown file on disk. MarkLab watches the file, syncs browser edits back to disk, and keeps local snapshots for recovery. Old cloud mutation endpoints are historical reference material, not the current local-first workflow.

## Start

From this repo:

```bash
npx -y pnpm@10.0.0 marklab open README.md
```

That starts a loopback-only local daemon, opens the browser editor, and keeps `README.md` synchronized with browser edits and external editor saves.

Foreground mode stays attached to the terminal:

```bash
marklab open README.md
```

Closing that terminal stops the local daemon.

Background mode keeps the daemon running after the launch command returns:

```bash
marklab open README.md --background
marklab status
marklab stop README.md
marklab stop --all
```

Background daemons are recorded in the user app-support directory. A second background open for the same canonical file reuses the existing daemon instead of starting a competing watcher.

## Local URL And Relay URL

`marklab open` prints a local browser URL such as:

```text
http://127.0.0.1:5175/local#token=...
```

That URL is private to the local daemon. It contains daemon access in the fragment so the browser can read and edit the opened file through loopback-only APIs. Do not share it.

Relay URLs are a later product surface for sharing. A relay URL is the shareable collaboration address; it does not make the local browser URL public. See [Local URL vs Relay URL](docs/product/local-url-vs-relay-url.md).

## Current Product Model

- The local Markdown file is the source of truth.
- Browser edits are serialized through the Milkdown/Yjs runtime and written back to the file.
- External saves from VS Code, Typora, Vim, Codex, Claude Code, or another local tool update the browser without refresh.
- Two local browser windows connected to the same daemon converge through the one local room.
- Manual snapshots and restore are local safety tools.
- If disk and browser edits conflict, Plan 01 protects both sides and shows: `File changed outside MarkLab. Review needed.`

## Active Local-First Plans

The active execution plans are:

- [Plan 01: Local File Sync MVP](plans/01_local_file_sync_mvp_plan.md)
- [Plan 02: Local Collaboration Relay MVP](plans/02_local_collaboration_relay_mvp_plan.md)
- [Plan 03: Reconnect Conflict Review](plans/03_reconnect_conflict_review_plan.md)
- [Plan 04: Hosted Relay Production And Distribution](plans/04_hosted_relay_production_and_distribution_plan.md)
- [Plan 05: AI Agent Operating Layer](plans/05_ai_agent_operating_layer_plan.md)
- [Plan 06: Legacy Cloud AI Write Cleanup](plans/06_legacy_cloud_ai_write_cleanup_plan.md)

Product journey docs:

- [Local-First User Journeys](docs/product/local-first-user-journeys.md)
- [Local URL vs Relay URL](docs/product/local-url-vs-relay-url.md)
- [AI Agent Guide](docs/agent/marklab-agent-guide.md)

## Using MarkLab With Codex, Claude Code, Or Cursor

Codex, Claude Code, Cursor, and similar agents should treat the local Markdown file as the write surface. MarkLab is process control and sync infrastructure around that file: agents can ask for status, create a safety snapshot, wait for convergence, inspect conflicts, and manage share links through the CLI.

MarkLab does not offer a cloud-side content mutation API for agents. Agents should not change Yjs state or database rows themselves.

Small edit:

```bash
marklab status README.md --json
# agent edits README.md locally
marklab wait README.md --synced --timeout 10000 --json
```

Large edit:

```bash
marklab status README.md --json
marklab save-version README.md --message "Before AI edit: broad README update" --json
# agent edits README.md locally
marklab wait README.md --synced --timeout 10000 --json
```

Install or inspect agent instructions:

```bash
marklab agent instructions --target codex
marklab agent install --target codex --write AGENTS.md
```

## Historical Reference

Root files named `00_*.md` through `09_*.md` and the files under `plans/Archive/cloud-first-reference/` are historical cloud-first reference material. They are retained because they explain prior Milkdown/Yjs decisions, but they are superseded by Plans 01 through 06 for current implementation work.

Do not revive cloud document dashboards, hosted mutation workflows, sidebars, workspace managers, or production relay behavior while executing Plan 01.
