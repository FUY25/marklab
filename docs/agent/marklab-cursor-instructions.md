# Cursor: MarkLab Local Agent Rules

MarkLab is local-file-first. The local Markdown file is the write surface, and MarkLab.app syncs file changes into the shared `/collab` document when sharing is active.

Before editing a shared file, confirm with the user that the file is the intended target.

During editing:

- Edit the `.md` file directly.
- Do not call hosted document mutation endpoints.
- Do not mutate Yjs state or Postgres rows.
- Do not use access tokens as an agent write API.
- Stop if MarkLab.app reports paused sync or conflict.

After editing, report the changed file and let the user confirm MarkLab.app sync state.

The old daemon CLI status/wait/version/conflict commands are archived compatibility commands and require `MARKLAB_ENABLE_LEGACY_CLI=1`.
