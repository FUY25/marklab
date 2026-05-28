# MarkLab Agent Docs

This directory is the operating manual for local coding agents that work with the current hosted native/Y-Sweet pilot.

- [Agent guide](marklab-agent-guide.md)
- [Codex instructions](marklab-codex-instructions.md)
- [Claude Code instructions](marklab-claude-code-instructions.md)
- [Cursor instructions](marklab-cursor-instructions.md)

The short version: agents edit the local Markdown file on disk. MarkLab.app watches that file and syncs it into the shared document. Agents do not appear as collaborators.

The current CLI can open files, route edit links into MarkLab.app, and inspect native sync/conflict state:

```bash
marklab open <file.md>
marklab share <file.md> --edit
marklab share <file.md> --view
marklab join 'https://<host>/collab?docId=...&branchId=...&token=...&mode=edit'
marklab status <file.md> --json
marklab wait <file.md> --synced --json
marklab conflict <file.md> --json
```

Use `share --edit` for a collaborator who can write and `share --view` for a read-only browser link. For content changes, edit the local Markdown file and use only the CLI commands listed above for coordination.
