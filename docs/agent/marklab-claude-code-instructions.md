# Claude Code: MarkLab Local Agent Rules

MarkLab watches local Markdown files and syncs them through the native relay app. Treat the `.md` file as the content surface.

- Edit Markdown through normal local file edits.
- Do not use hosted mutation endpoints for content changes.
- Do not mutate Yjs state or Postgres rows.
- Do not use access tokens as an agent write path.
- If MarkLab.app reports paused sync or a conflict, stop editing the watched file and report it to the user.
- Agents are not collaborators in the presence UI; they work through the local file.
- For broad edits, ask for or confirm an external checkpoint until the native hosted Versions UI is complete.

The current normal CLI command only opens hosted edit links in MarkLab.app:

```bash
marklab join 'https://<host>/collab?docId=...&branchId=...&token=...&mode=edit'
```

Archived daemon commands such as `status`, `wait`, `save-version`, and `conflict` require `MARKLAB_ENABLE_LEGACY_CLI=1`.
