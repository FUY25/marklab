# AGENTS.md: MarkLab Local Agent Rules

This project uses MarkLab as a local-first Markdown collaboration tool.

Follow these rules when editing MarkLab-watched Markdown files:

1. Edit the local `.md` file on disk. The filesystem is the content editing surface.
2. Use only the CLI commands below for sharing and sync coordination.
3. If MarkLab.app reports paused sync or an open conflict, stop editing the watched file and report the state to the user.
4. For broad edits, ask the user to create or confirm an external checkpoint such as Git or Time Machine.
5. Do not list yourself as a collaborator. Agents are represented by local file edits, not presence sessions.

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
