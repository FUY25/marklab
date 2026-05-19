# Claude Code: MarkLab Local Agent Rules

MarkLab watches local Markdown files and syncs them through the native relay app. Treat the `.md` file as the content surface.

- Edit Markdown through normal local file edits.
- Do not use hosted mutation endpoints for content changes.
- Do not mutate Yjs state or Postgres rows.
- Do not use access tokens as an agent write path.
- If MarkLab.app reports paused sync or a conflict, stop editing the watched file and report it to the user.
- Agents are not collaborators in the presence UI; they work through the local file.
- For broad edits, ask for or confirm an external checkpoint until the native hosted Versions UI is complete.

The current normal CLI surface routes files and hosted edit links through MarkLab.app:

```bash
marklab doctor --json
marklab open <file.md>
marklab share <file.md>
marklab join 'https://<host>/collab?docId=...&branchId=...&token=...&mode=edit'
marklab status <file.md> --json
marklab wait <file.md> --synced --json
marklab conflict <file.md> --json
```

`open` and `share` open the local file in MarkLab.app; `share` does not create a hidden daemon relay link. MarkLab.app owns Start Sharing, workspace-owned document creation, and access-link creation. `status`, `wait`, and `conflict` read MarkLab.app support files for native sync/conflict state.

Archived daemon commands such as `open --background`, `create-link`, `revoke-link`, `stop`, `save-version`, and `versions` require `MARKLAB_ENABLE_LEGACY_CLI=1`; packaged `@marklab/cli` intentionally does not bundle that old runtime.
