# MarkLab Agent Guide

MarkLab agents edit local Markdown files. They do not appear as collaborators and they do not write hosted Yjs state directly.

## Current Pilot Rule

Use the filesystem as the content surface:

```text
agent edits local .md
  -> MarkLab.app file watcher observes the disk change
  -> active shared document ingests the change
  -> browser/app collaborators receive it through /collab
```

Do not call hosted document mutation endpoints for content changes. Do not mutate Yjs state or Postgres rows. Do not use access-grant tokens as an agent write API.

## Before Editing

Ask the user which file is active if it is not obvious. If the file is in a shared MarkLab.app session, keep edits focused and avoid repeated rewrite loops.

For broad rewrites, ask the user to create a safety checkpoint first. The native hosted Versions UI is not complete yet, so Git, Time Machine, or another external backup is the reliable pilot checkpoint.

## During Editing

Write the local `.md` file with normal tools.

If MarkLab.app reports a paused sync state or conflict, stop changing that watched file. Prepare a separate draft only if the user asks for help resolving the conflict.

## After Editing

Tell the user which file changed and use the native relay CLI status surface when available:

```bash
marklab status <file.md> --json
marklab wait <file.md> --synced --json
marklab conflict <file.md> --json
```

These commands read MarkLab.app support files and do not use the archived local daemon. If `conflict` reports an open conflict, stop editing the watched file and let the user resolve it in MarkLab.app.

## Link Management

Agents should not create or revoke links through undocumented APIs. Link creation, copy, revoke, active collaborators, and local sync state belong in the native collaboration inspector for the current pilot.

Normal new-pilot CLI commands are UI/native routing and sync inspection:

```bash
marklab doctor --json
marklab open <file.md>
marklab share <file.md>
marklab join 'https://<host>/collab?docId=...&branchId=...&token=...&mode=edit'
```

View links stay browser-only.

## Deferred Control Surface

The remaining planned hosted agent control surface is:

- `save-version`
- `versions`

Those commands must bind to the new relay/native session model before becoming normal pilot guidance. The archived local-daemon versions of those commands are not the new product path and require `MARKLAB_ENABLE_LEGACY_CLI=1`.
