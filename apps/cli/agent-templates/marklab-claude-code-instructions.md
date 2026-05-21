# Claude Code: MarkLab Local Agent Rules

MarkLab watches local Markdown files and syncs them through the native relay app. Treat the `.md` file as the content surface.

- Edit Markdown through normal local file edits.
- Use only the CLI commands below for sharing and sync coordination.
- If MarkLab.app reports paused sync or a conflict, stop editing the watched file and report it to the user.
- Agents are not collaborators in the presence UI; they work through the local file.
- For broad edits, ask for or confirm an external checkpoint.

The current normal CLI surface routes files and hosted edit links through MarkLab.app:

```bash
marklab doctor --json
marklab open <file.md>
marklab share <file.md> --edit
marklab share <file.md> --view
marklab join 'https://<host>/collab?docId=...&branchId=...&token=...&mode=edit'
marklab status <file.md> --json
marklab wait <file.md> --synced --json
marklab conflict <file.md> --json
```

`share --edit` and `share --view` ask MarkLab.app to start or reuse native sharing in the background, create the requested access link, copy it to the clipboard, and print it. Use `status`, `wait`, and `conflict` before or after local edits when you need sync state.
