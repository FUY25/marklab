# Claude Code: MarkLab Local Agent Rules

MarkLab watches local Markdown files and syncs them with the browser editor. Treat the `.md` file as canonical.

- Edit Markdown through normal local file edits.
- Use `marklab status <file> --json` before touching a watched file.
- Use `marklab save-version <file> --message "Before AI edit: <reason>" --json` before broad edits.
- Use `marklab wait <file> --synced --timeout 10000 --json` after edits.
- If MarkLab reports a paused sync state or an open conflict, stop editing the watched file and ask the user how to proceed.
- You may prepare a separate resolved draft file during a conflict, but do not keep changing the watched conflicted file.
- Use CLI share/link/status/version/doctor commands for MarkLab control.
- Never use cloud document mutation endpoints for agent content changes.
- Never mutate Yjs state or Postgres rows yourself.
