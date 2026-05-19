# MarkLab Agent Guide

MarkLab agents edit local Markdown files. They do not appear as collaborators.

## Current Pilot Rule

Use the filesystem as the content surface:

```text
agent edits local .md
  -> MarkLab.app file watcher observes the disk change
  -> active shared document ingests the change
  -> browser/app collaborators receive it
```

Use the local Markdown file as the only content write surface.

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

If `conflict` reports an open conflict, stop editing the watched file and let the user resolve it in MarkLab.app.

## Link Management

Agents should create links only through the CLI commands below. Link revoke, active collaborator review, and conflict resolution belong in MarkLab.app.

Normal new-pilot CLI commands are UI/native routing and sync inspection:

```bash
marklab doctor --json
marklab open <file.md>
marklab share <file.md> --edit
marklab share <file.md> --view
marklab join 'https://<host>/collab?docId=...&branchId=...&token=...&mode=edit'
```

Use `share --edit` when the user needs a writable collaborator link and `share --view` for read-only review. View links stay browser-only. For content changes, edit the local Markdown file and use only the CLI commands listed above for coordination.
