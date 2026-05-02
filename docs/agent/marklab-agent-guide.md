# MarkLab Agent Guide

MarkLab is local-file-first. The Markdown file on disk is the editing surface, and the browser is a synchronized editor over that file.

Agents may control MarkLab through the CLI:

```bash
marklab status README.md --json
marklab wait README.md --synced --timeout 10000 --json
marklab save-version README.md --message "Before AI edit: update docs" --json
marklab versions README.md --json
marklab doctor README.md --json
```

Agents must edit local Markdown files with normal filesystem tools. MarkLab does not provide an agent content mutation API. Do not call cloud document mutation endpoints, do not mutate Yjs state yourself, and do not write Postgres rows yourself.

## Small Edit

```bash
marklab status README.md --json
# edit README.md locally
marklab wait README.md --synced --timeout 10000 --json
```

Report the changed file and the final `syncState`.

## Large Edit

```bash
marklab status README.md --json
marklab save-version README.md --message "Before AI edit: broad rewrite" --json
# edit README.md locally
marklab wait README.md --synced --timeout 10000 --json
```

Save a version before broad edits, risky rewrites, or multi-section restructuring. Do not restore versions unless the user explicitly asks for a restore workflow.

## Conflict Handling

If `status` reports `syncState: "paused"` or `hasConflict: true`, stop editing the watched file.

Use:

```bash
marklab conflict README.md --json
```

Tell the user what MarkLab reported. You may write a separate draft file or produce text for the user to paste into the conflict review UI, but do not keep changing the watched conflicted file.

## Sharing And Relay State

Agents may inspect or manage share links:

```bash
marklab share README.md --json
marklab share-state README.md --json
marklab create-link README.md --role view --json
marklab create-link README.md --role edit --json
marklab revoke-link README.md <grant-id> --json
```

Link creation returns a copyable relay URL once. `share-state` is for inspection and must not be treated as a content editing path.

## Error Contract

Agent JSON failures have this shape:

```json
{
  "ok": false,
  "code": "sync_timeout",
  "message": "Timed out waiting for MarkLab to observe the local file state.",
  "details": {}
}
```

Exit codes are stable:

```text
0 success
1 general failure
2 invalid command or target
3 daemon not running
4 sync paused or conflict required
5 host offline
6 timeout
7 doctor failure
8 feature or dependency unavailable
```

When `--json` is used, stdout is JSON only. Diagnostics belong on stderr.

## Installable Instructions

Print target-specific instructions:

```bash
marklab agent instructions --target codex
marklab agent instructions --target claude
marklab agent instructions --target cursor
```

Install Codex instructions only with an explicit write path:

```bash
marklab agent install --target codex --write AGENTS.md
```

The install command refuses to overwrite an existing file unless `--force` is supplied.
