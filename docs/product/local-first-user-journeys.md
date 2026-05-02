# Local-First User Journeys

MarkLab starts from one local Markdown file. The file on disk is canonical; the browser is a synchronized editor over that file.

## Solo Local File

1. The user runs `marklab open README.md`.
2. MarkLab starts a loopback daemon for the canonical realpath.
3. The browser opens `/local` with a per-daemon token in the URL fragment.
4. Browser edits are serialized and written atomically to `README.md`.
5. Saves from local tools update the browser without refresh.
6. Manual snapshots and restore stay in local app-support metadata.

## Browser Collaborator

This is the same local daemon with another browser window on the same machine.

1. The host opens the local URL in a second browser window.
2. Both browser windows connect to the one local Yjs room.
3. Edits converge through the daemon.
4. The daemon writes the converged Markdown back to the canonical file.

The local URL is private to the host machine and should not be shared as a collaboration link.

## Local Mirror Collaborator

Plan 02 introduces relay-assisted collaboration. A local mirror collaborator should still have a local Markdown file as their own canonical working copy.

1. The host shares a relay edit link.
2. The collaborator joins with a local mirror file.
3. Their browser and local file sync through their own daemon.
4. Relay transport coordinates document updates between host and collaborator.

Plan 01 does not implement this mirror join flow; it only establishes the single-file local daemon that mirror collaboration will reuse.

## Host Offline

1. The local daemon continues to sync the host browser and local file without relay access.
2. External tools can keep editing the file on disk.
3. Local snapshots remain available.
4. Remote collaborators cannot receive new host updates until relay connectivity returns.

Offline local work must never depend on a hosted document store.

## Reconnect Conflict

Plan 01 only protects against silent overwrite.

1. Browser has unflushed edits.
2. The disk file changes outside MarkLab.
3. The daemon refuses to overwrite disk.
4. The browser draft stays visible.
5. The disk file stays intact.
6. The browser shows `File changed outside MarkLab. Review needed.`

Plan 03 owns the full review and choose-side flow.

## AI Agent Editing Local Files

AI agents edit Markdown files directly in the filesystem. That keeps MarkLab aligned with Codex, Claude Code, editors, and shell tools.

1. The user points the agent at the local file.
2. The agent edits that file with normal local file operations.
3. The daemon sees the save and updates the browser room.
4. If the browser also has unsaved edits, MarkLab surfaces the conflict state instead of replacing either side.

Agents do not need a hosted document mutation surface for Plan 01.

See the [MarkLab Agent Guide](../agent/marklab-agent-guide.md) for the CLI contract and target-specific instructions.

## Agent Small Edit

1. The agent runs `marklab status README.md --json`.
2. The agent edits `README.md` with normal local file operations.
3. The agent runs `marklab wait README.md --synced --timeout 10000 --json`.
4. The agent reports the changed file and final sync state.

The local Markdown file remains first; MarkLab only coordinates watching, browser sync, versions, and share state.

## Agent Large Edit

1. The agent runs `marklab status README.md --json`.
2. The agent runs `marklab save-version README.md --message "Before AI edit: broad update" --json`.
3. The agent edits `README.md` locally.
4. The agent runs `marklab wait README.md --synced --timeout 10000 --json`.
5. The agent reports the version id and sync state.

If `status` reports `syncState: "paused"` or `hasConflict: true`, the agent stops editing the watched file and asks the user to resolve the conflict in MarkLab. It may prepare a separate draft, but it should not keep changing the paused watched file.
