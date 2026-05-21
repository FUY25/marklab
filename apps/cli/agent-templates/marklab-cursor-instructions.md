# Cursor: MarkLab Local Agent Rules

MarkLab is local-file-first. The local Markdown file is the write surface, and MarkLab.app syncs file changes into the shared `/collab` document when sharing is active.

Before editing a shared file, confirm with the user that the file is the intended target.

During editing:

- Edit the `.md` file directly.
- Use only the CLI commands below for sharing and sync coordination.
- Stop if MarkLab.app reports paused sync or conflict.

After editing, report the changed file and inspect MarkLab.app native sync state when useful:

```bash
marklab status <file.md> --json
marklab wait <file.md> --synced --json
marklab conflict <file.md> --json
```

Normal CLI routing uses MarkLab.app:

```bash
marklab open <file.md>
marklab share <file.md> --edit
marklab share <file.md> --view
marklab join 'https://<host>/collab?docId=...&branchId=...&token=...&mode=edit'
```

`share --edit` and `share --view` ask MarkLab.app to start or reuse native sharing in the background, create the requested access link, copy it to the clipboard, and print it.
