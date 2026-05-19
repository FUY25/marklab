# Cursor: MarkLab Local Agent Rules

MarkLab is local-file-first. The local Markdown file is the write surface, and MarkLab.app syncs file changes into the shared `/collab` document when sharing is active.

Before editing a shared file, confirm with the user that the file is the intended target.

During editing:

- Edit the `.md` file directly.
- Do not call hosted document mutation endpoints.
- Do not mutate Yjs state or Postgres rows.
- Do not use access tokens as an agent write API.
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
marklab share <file.md>
marklab join 'https://<host>/collab?docId=...&branchId=...&token=...&mode=edit'
```

`share` opens the local file in MarkLab.app and leaves Start Sharing/access-link creation to the native UI. Archived daemon commands such as `open --background`, `create-link`, `revoke-link`, `stop`, `save-version`, and `versions` require `MARKLAB_ENABLE_LEGACY_CLI=1`; packaged `@marklab/cli` intentionally does not bundle that old runtime.
