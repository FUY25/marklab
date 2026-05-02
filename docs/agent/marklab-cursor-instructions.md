# Cursor: MarkLab Local Agent Rules

MarkLab is local-file-first. The local Markdown file is the source of truth, and MarkLab syncs that file into the browser editor.

Before editing a watched Markdown file:

```bash
marklab status README.md --json
```

Before broad edits:

```bash
marklab save-version README.md --message "Before AI edit: <reason>" --json
```

After local file edits:

```bash
marklab wait README.md --synced --timeout 10000 --json
```

If sync is paused or a conflict is open, stop editing the watched file. Use `marklab conflict <file> --json` to inspect state and report it to the user. You may draft a resolution in a separate file, but do not keep mutating the watched conflicted file.

Do not use cloud document mutation endpoints for content changes. Do not mutate Yjs state or Postgres rows yourself. Use the MarkLab CLI only for process control, status, waiting, snapshots, diagnostics, and sharing.
