# MarkLab Agent Docs

This directory is the operating manual for local coding agents that work with the current MarkLab relay/native pilot.

- [Agent guide](marklab-agent-guide.md)
- [Codex instructions](marklab-codex-instructions.md)
- [Claude Code instructions](marklab-claude-code-instructions.md)
- [Cursor instructions](marklab-cursor-instructions.md)

The short version: agents edit the local Markdown file on disk. MarkLab.app watches that file and syncs it into the shared `/collab` document. Agents do not appear as collaborators and should not use hosted mutation endpoints or access tokens as a write API.

The current CLI can open files, route edit links into MarkLab.app, and inspect native sync/conflict state:

```bash
marklab open <file.md>
marklab share <file.md>
marklab join 'https://<host>/collab?docId=...&branchId=...&token=...&mode=edit'
marklab status <file.md> --json
marklab wait <file.md> --synced --json
marklab conflict <file.md> --json
```

The old daemon commands that create local relay links or run background mirrors remain archived compatibility only and require `MARKLAB_ENABLE_LEGACY_CLI=1`; packaged `@marklab/cli` does not bundle that old runtime.
