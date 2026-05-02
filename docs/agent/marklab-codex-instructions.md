# AGENTS.md: MarkLab Local Agent Rules

This project uses MarkLab as a local-first Markdown collaboration tool.

Follow these rules when editing MarkLab-watched Markdown files:

1. Edit the local `.md` file on disk. The filesystem is the content editing surface.
2. Use `marklab status <file> --json` before edits when a file may be watched.
3. Use `marklab save-version <file> --message "Before AI edit: <reason>" --json` before broad edits.
4. After editing, run `marklab wait <file> --synced --timeout 10000 --json`.
5. If `syncState` is `paused` or `hasConflict` is `true`, stop editing that watched file and report the conflict.
6. Use `marklab conflict <file> --json` to inspect available conflict state. Do not resolve conflicts unless the user explicitly asks.
7. You may use MarkLab CLI commands for status, waiting, versions, doctor, sharing, and link management.
8. Do not call cloud document mutation endpoints for content changes.
9. Do not mutate Yjs state or Postgres rows yourself.
10. Do not add MarkLab content mutation commands; keep content writes as local file edits.

Useful workflows:

```bash
marklab status README.md --json
marklab wait README.md --synced --timeout 10000 --json
```

```bash
marklab status README.md --json
marklab save-version README.md --message "Before AI edit: broad rewrite" --json
marklab wait README.md --synced --timeout 10000 --json
```
