# Local-First Markdown File Collaboration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. This is a directional plan, not a final executable task list. Before implementation, turn the chosen phase into a narrower task plan with failing tests first.

**Goal:** Make MarkLab feel like a local Markdown collaboration layer for coders: the default unit is one `.md` file on disk, any local Markdown tool can edit that file, and the online service exists only to help collaboration, identity, relay, and sharing.

**Architecture:** A lightweight local MarkLab daemon owns one live Yjs/Hocuspocus room per local Markdown file, watches the file for external changes, writes browser/remote/AI edits back to disk, and keeps the live room synchronized. The hosted service becomes a control plane and relay: it manages access links, identities, and websocket routing, but it is not the canonical document store for local-first documents.

**Tech Stack:** Node.js/TypeScript, Hocuspocus/Yjs, Milkdown/ProseMirror transformer, existing `LiveMarkdownWriter`, local file watcher, atomic filesystem writes, local metadata store, optional hosted relay using the existing access/session model.

---

## Product Thesis

MarkLab should not ask coders to trust a new document silo before they can collaborate. The product should start from the object coders already understand:

```text
a Markdown file in a local folder or Git repo
```

The online backend should be an instrument, not the place the document primarily lives. It should help other people and AI agents connect to the live session, but the user's file remains the source of truth.

This changes the product definition from:

```text
A cloud Markdown workspace with import/export
```

to:

```text
A local Markdown file with live collaboration, share links, and AI-safe sync
```

## Default User Journey

MVP local-first flow:

```text
marklab open ./README.md
```

MarkLab starts a local daemon if needed, opens the browser, and mounts the clean editor for that file.

The user can also keep editing the same file in Typora, VS Code, Cursor, Zed, Obsidian, Vim, or any other Markdown-capable tool. MarkLab does not require the user to choose MarkLab as the only editor.

Expected behavior:

- Browser edits write back to `README.md`.
- External file saves are detected and applied into the active collaborative room.
- Remote collaborators see local/external changes without manual refresh.
- Local tools see remote/browser edits after MarkLab writes the file.
- AI agents can either write the file directly or use a localhost MarkLab API; both paths converge into the same live room.
- Share links still work, but they are links into the hosted relay for this local file session.
- If the local daemon is offline, the file is not secretly edited in the cloud.

## Product Principles

- **Default unit is one Markdown file.** Folder/project support should be designed for later, but the first real slice should make one file excellent.
- **Local file is canonical.** Yjs state is the live collaboration projection. The hosted backend is not the long-term source of truth for local-first documents.
- **Tool agnostic.** MarkLab should work with Typora, IDEs, terminal editors, AI coding agents, and any tool that reads/writes the Markdown file.
- **No permanent heavy left pane.** A launcher/recent-files surface is fine, but the editor should stay clean.
- **No branch UI for local-first MVP.** Coders already have Git branches. MarkLab versions are live collaboration snapshots and rollback points, not a replacement for Git.
- **No hidden cloud-only writes.** If a remote collaborator edits, the local daemon must eventually write the file on disk or clearly report that the host is offline.
- **Same correctness rule as restore.** Any accepted external, AI, restore, or remote change must update the active Yjs/Hocuspocus room, not only storage.

## High-Level Architecture

```text
Local Markdown file
  README.md
        ^
        | atomic writes + file watch
        v
Local MarkLab daemon
  local file registry
  one Y.Doc room per file
  Hocuspocus server
  Milkdown transformer
  LiveMarkdownWriter
  local snapshot metadata
        ^
        | localhost browser/API
        v
MarkLab web editor
  clean Milkdown/Crepe canvas
  versions/share drawers
        ^
        | outbound relay connection
        v
Hosted MarkLab relay
  access links
  session identity
  websocket relay
  optional ephemeral room cache
        ^
        |
Remote collaborators / AI agents
```

The local daemon should make an outbound connection to the hosted relay. Remote collaborators connect to the relay; the user's machine does not need to accept inbound internet traffic.

## Local Daemon Responsibilities

The daemon owns local-first document state for one or more opened files.

For each file, track:

```ts
type LocalFileDocument = {
  localDocId: string;
  absolutePath: string;
  displayName: string;
  roomName: string;
  lastDiskHash: string;
  lastAppliedMarkdownHash: string;
  lastWriteOperationId: string | null;
  dirtySince: string | null;
  relayId: string | null;
};
```

Responsibilities:

- Resolve and validate the target `.md` path.
- Read the file from disk.
- Initialize the live room through the Milkdown transformer, not raw text injection.
- Watch the file for external saves.
- Debounce filesystem events.
- Ignore self-writes using operation ids and content hashes.
- Flush active Yjs state before writing disk, exporting, versioning, restoring, or serving AI reads.
- Apply external disk changes through `LiveMarkdownWriter`.
- Apply restore/remote/AI changes back into the active Yjs room.
- Write Markdown back to disk atomically.
- Maintain lightweight local snapshots for rollback.

## File Watcher Rules

The watcher is deliberately boring:

```text
fs event
  -> debounce
  -> read file
  -> hash content
  -> if hash equals last self-write hash, ignore
  -> flush active room
  -> compare disk hash and live hash
  -> apply external content through LiveMarkdownWriter
  -> persist returned non-empty yjsState locally
  -> broadcast applied state to connected clients
```

Use a mature watcher such as `chokidar` unless the dependency is unacceptable. `fs.watch` is possible, but it has platform-specific edge cases that are not worth owning early.

The watcher should not canonicalize and rewrite the file on every external save. It should preserve the user's file as much as possible, apply the external content into the live editor, and only write back when MarkLab-originated edits need to update disk.

## Atomic Disk Writes

Browser, remote, restore, and AI API writes should update the local file with an atomic write:

```text
serialize live Yjs/ProseMirror through Milkdown
  -> canonical Markdown
  -> write to temporary sibling file
  -> fsync if practical
  -> rename over target file
  -> update lastDiskHash and lastWriteOperationId
```

This avoids partially written Markdown if the process dies mid-write.

## Collaboration Semantics

There are four write sources:

```text
1. Browser editor edits
2. Remote collaborator edits through relay
3. External local editor saves
4. AI writes, either direct file writes or localhost API calls
```

All four must converge through the same room and writer path:

```text
incoming content/change
  -> flush active room if needed
  -> apply through LiveMarkdownWriter/Milkdown transformer
  -> require non-empty encoded yjsState
  -> persist local state
  -> update active Hocuspocus/Y.Doc room
  -> write canonical Markdown to disk when the source is not the disk itself
  -> create local snapshot when policy says so
```

Do not add a second restore/version/write path for local-first mode. The existing live writer correctness rule should become the system rule for every source.

## Hosted Relay Role

The hosted service should do less, but do it reliably.

It should own:

- access grants
- view/edit permission
- access session identity
- active collaborator names/colors
- websocket relay between local daemon and remote browsers
- revocation
- optional ephemeral latest Yjs room cache while the host is online

It should not be the canonical long-term document store for local-first documents.

For MVP, if the local daemon disconnects:

```text
edit links become unavailable or read-only with a clear offline message
view links can show the last relayed snapshot only if the product explicitly marks it as stale
no remote edit should be accepted as if the host file can be updated
```

Do not build offline remote edit queues in the first local-first version. They create hard conflict semantics and make the product feel magical in the bad way.

## AI Integration

The AI path should be local-tool agnostic.

Supported paths:

```text
AI writes file directly
  -> watcher detects save
  -> MarkLab applies file content into active room
  -> collaborators see update

AI uses localhost MarkLab API
  -> API checks base hash/version
  -> LiveMarkdownWriter applies change
  -> active room updates
  -> file is atomically written
```

The localhost API is safer because it can return structured conflicts such as `stale_base`, `old_string_not_found`, or `ambiguous_match`. But direct file writes should still work because the product promise is local tool agnostic.

Recommended MarkLab agent guidance:

```text
If MarkLab daemon is available, prefer localhost read/edit/write APIs.
If unavailable, normal filesystem read/write still works, but you lose live conflict feedback.
```

## Versioning And Rollback

Local-first versions are collaboration snapshots, not a Git replacement.

Store snapshots locally by default:

```text
~/Library/Application Support/MarkLab/marklab.db
```

Suggested tables:

```text
local_documents(local_doc_id, absolute_path, display_name, created_at, last_opened_at)
local_document_state(local_doc_id, room_name, yjs_state, current_markdown, current_hash, updated_at)
local_versions(version_id, local_doc_id, operation, markdown_snapshot, yjs_state, hash, created_at, actor)
relay_bindings(local_doc_id, relay_id, created_at, last_connected_at)
```

Do not create `.marklab/` in the user's project by default. A project-local metadata mode can be added later if users want portable MarkLab history.

Restore behavior:

```text
flush active room
  -> restore selected snapshot through LiveMarkdownWriter
  -> require returned non-empty yjsState
  -> write restored Markdown to disk atomically
  -> create rollback snapshot
  -> apply yjsState back to active room
  -> relay update to remote collaborators
```

This is the same restore correctness rule already established for cloud branches, with disk added as another required sink.

## Conflict Policy

The MVP conflict policy should be conservative and visible.

Normal clean case:

```text
external editor saves file
  -> live room has no unflushed conflicting edits
  -> apply external content to room
  -> broadcast
```

Browser/remote clean case:

```text
browser or remote edit changes live room
  -> debounce serialize
  -> disk hash still equals lastDiskHash
  -> atomic write file
```

Race case:

```text
browser has dirty live edits
external editor saves a different file state
```

MVP behavior:

- Create a local snapshot of the live room before applying anything.
- Try to apply the external file content through the writer as the next operation.
- If the writer cannot apply cleanly or the live hash changed during the attempt, stop and show a quiet conflict state.
- Do not silently overwrite the disk file.

Conflict UI copy should be plain:

```text
File changed outside MarkLab. Review needed.
```

Follow-up controls can be:

```text
Use file version
Use MarkLab version
Export conflict copy
```

Do not build a full visual merge tool in the first version.

## UI Shape

The editor should remain close to the current clean Crepe canvas.

Persistent UI:

```text
[Markdown document canvas]

                                  [+ new/open file]
                                  [Versions]
                                  [Share]
```

No visible document id. No branch id. No admin token card. No left sidebar by default.

The home/launcher page should be a simple recent-file launcher:

```text
Open Markdown File
Recent Files
```

The recent-file list answers "where did my documents go?" without turning MarkLab into a heavy document manager.

## Key Changes From Current Cloud-First MVP

- Add a local daemon mode.
- Add a local file watcher.
- Treat one `.md` file as the default document unit.
- Treat cloud `doc_id/branch_id` as an implementation detail for hosted cloud documents, not the local-first UX.
- Reuse the existing clean document UI, but route local docs by local document id/path.
- Reuse the existing access grant/session model for remote collaboration.
- Replace cloud canonical storage with local file canonical storage for local-first docs.
- Keep versions local unless sharing requires relay snapshots.
- Keep branch functionality hidden for local-first MVP.
- Update AI guidance so local files and localhost APIs are first-class.

## Rough Implementation Phases

### Phase 0: Keep Current Cloud Work Stable

Do not delete the Plan 6.7 work. It gives useful primitives:

- Hocuspocus room lifecycle
- access grants
- access sessions
- view/edit roles
- active-room apply hooks
- restore correctness
- LiveMarkdownWriter

Local-first should reuse those pieces instead of building a parallel collaboration stack.

### Phase 1: File-Backed Local Room Inside Existing API Process

Implement the smallest local-first slice inside `apps/api` before extracting a packaged daemon.

Candidate files:

- Create `apps/api/src/local/local-file-registry.ts`
- Create `apps/api/src/local/local-file-watcher.ts`
- Create `apps/api/src/local/local-file-writer.ts`
- Create `apps/api/src/routes/local-file-routes.ts`
- Modify `apps/api/src/http/app.ts`
- Modify `apps/api/src/collab/server.ts`
- Modify `apps/web/src/routes.ts`
- Create `apps/web/src/pages/LocalDocumentPage.tsx`

Behavior:

- Start API with a local file path in development.
- Register that path as a local document.
- Open a browser route for the local document.
- Seed Hocuspocus/Yjs state from the file.
- Browser edits write back to disk.
- External disk writes update the browser.

This phase proves the core loop without packaging decisions.

### Phase 2: CLI Entry Point

Add:

```text
marklab open ./README.md
```

Candidate structure:

- Create `apps/cli`
- CLI resolves the path.
- CLI starts or connects to the local daemon.
- CLI opens the browser to the local document URL.

No cloud relay is required in this phase.

### Phase 3: Local Metadata And Snapshots

Add local state storage.

Recommendation:

```text
SQLite in ~/Library/Application Support/MarkLab/marklab.db
```

Reason:

- local
- portable enough
- simple queries
- better than a growing JSON file
- does not require Postgres for local-first use

Use it for local document registry, current Yjs state, current Markdown hash, and version snapshots.

### Phase 4: Hosted Relay Share Links

Add relay mode after the local file loop works.

Flow:

```text
local daemon connects outbound to hosted relay
user creates edit/view link
remote browser connects to hosted relay
relay bridges Yjs updates between remote browser and local daemon
local daemon writes accepted changes to disk
```

Reuse existing Plan 6.7 access grants and session identity as much as possible.

### Phase 5: AI-First Local Tooling

Add agent guidance and local API polish:

- `read_file_doc`
- `edit_file_doc`
- `write_file_doc`
- `list_file_versions`
- `restore_file_version`

These can be localhost routes or CLI commands. The agent skill should prefer them when the daemon is running, but normal filesystem edits still work.

## Acceptance Tests

Minimum automated tests for Phase 1:

- Browser edit writes the expected Markdown to disk.
- External disk edit updates active Hocuspocus state.
- External disk edit is visible in the browser without refresh.
- Self-write watcher events are ignored.
- Restore writes disk and active Yjs state.
- Direct file write by a simulated AI process updates connected collaborators.
- Two browser sessions converge when one edits through the browser and one edit arrives from disk.
- If the file is changed externally during a dirty local room, MarkLab does not silently overwrite either side.

Manual E2E:

```text
1. Create /tmp/marklab-local-test.md.
2. Run marklab open /tmp/marklab-local-test.md.
3. Edit in the browser and confirm the file changes on disk.
4. Edit the same file in VS Code/Typora and confirm the browser updates.
5. Open a second browser window and confirm both windows converge.
6. Simulate AI by writing the file from a terminal command and confirm both browsers update.
7. Restore an older version and confirm the file, local browser, and second browser all show the restored content.
8. Share through relay and confirm a remote edit writes to the host file while the daemon is online.
9. Kill the daemon and confirm remote edit link clearly reports offline/unavailable instead of accepting edits.
```

## Risks

- **Markdown round-trip drift:** Milkdown serialization may rewrite formatting. Mitigation: avoid rewriting external saves until MarkLab itself needs to write; keep canonicalization conservative.
- **File watcher duplicate events:** Debounce and hash every read.
- **Self-write loops:** Track operation ids and hashes.
- **Conflict ambiguity:** Do not pretend to merge everything. Snapshot first and show a conflict state when uncertain.
- **Remote offline semantics:** Do not accept remote edits when the local file owner daemon cannot write them to disk.
- **Local metadata privacy:** Keep metadata local by default. Do not upload file paths unless needed for user-visible relay labels, and even then prefer basename only.

## Open Decisions

Recommended defaults:

- Local metadata store: SQLite in the user's application support directory.
- Hosted relay offline behavior: edit unavailable when daemon is offline.
- Project `.marklab/` directory: do not create by default.
- Folder/project support: defer until single-file mode is stable.
- Git integration: defer; keep Git as the user's existing durable history.

The first implementation decision to confirm is whether Phase 1 should live temporarily inside `apps/api` or start directly as a new local daemon package. My recommendation is to start inside `apps/api` to reuse Hocuspocus, LiveMarkdownWriter, and the current web route quickly, then extract once the loop is proven.
