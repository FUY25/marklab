# AGENTS.md: MarkLab Local Agent Rules

This project uses MarkLab as a local-first Markdown collaboration tool.

Follow these rules when editing MarkLab-watched Markdown files:

1. Edit the local `.md` file on disk. The filesystem is the content editing surface.
2. Do not call hosted document mutation endpoints for content changes.
3. Do not mutate Yjs state or Postgres rows.
4. Do not use share/access tokens as an agent write API.
5. If MarkLab.app reports paused sync or an open conflict, stop editing the watched file and report the state to the user.
6. For broad edits, ask the user to create or confirm an external checkpoint such as Git or Time Machine until the native hosted Versions UI is complete.
7. Do not list yourself as a collaborator. Agents are represented by local file edits, not presence sessions.

The current normal CLI surface only opens hosted edit links in MarkLab.app:

```bash
marklab join 'https://<host>/collab?docId=...&branchId=...&token=...&mode=edit'
```

The older `status`, `wait`, `save-version`, and `conflict` commands are archived local-daemon compatibility commands unless `MARKLAB_ENABLE_LEGACY_CLI=1` is set.
