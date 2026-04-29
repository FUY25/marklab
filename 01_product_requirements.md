# Product Requirements

## Primary personas

### Human collaborator

A researcher, founder, strategist, or engineer writing a shared Markdown document with teammates in a browser.

### AI coding/research agent

Claude Code, Codex, or another agent that needs to read and write the shared document without using the visual UI. The MVP integration path is MarkLab CLI + a MarkLab agent skill; MCP is a later adapter, not the first workflow.

## Core user journeys

### Journey A: create from blank

1. User opens the app.
2. User clicks **New Markdown Doc**.
3. App creates `doc_id` and default `main` branch.
4. User edits in Milkdown visual editor.
5. System updates collaboration state and canonical Markdown mirror.
6. User exports `.md` if needed.

Acceptance criteria:

- The document persists after refresh.
- A second browser can join the same doc and see edits in realtime.
- Exported Markdown contains the current document content.

### Journey B: create from local Markdown

1. User uploads `strategy.md`.
2. App canonicalizes the Markdown using the supported grammar and formatter.
3. App creates a cloud doc from the canonical Markdown.
4. Milkdown renders the content visually.
5. App records version `v1` with operation `import`.

Acceptance criteria:

- Supported headings, lists, tables, code fences, links, images, blockquotes, math fences, Mermaid fences, and YAML frontmatter survive import/export semantically.
- The exported file is named with doc/version/date/hash metadata.
- The Markdown body is not modified to add app metadata by default.

### Journey C: human collaboration

1. Owner creates an edit link.
2. Teammate opens link.
3. Both users edit the visual document.
4. Both see the same final content.
5. Presence shows both users connected.

Acceptance criteria:

- Concurrent edits converge.
- No user must manually refresh.
- Presence does not need cursor or selection fidelity in MVP, but connected collaborators should be visible.

### Journey D: AI reads and edits

1. User creates an agent token for a doc/branch.
2. Agent calls `read_doc` and receives canonical Markdown, version, and hash.
3. Agent may call `snapshot create` to materialize a local `proposal.md` plus `metadata.json` for native Codex/Claude Code diff review.
4. Agent edits `proposal.md` using a native Edit-style exact replacement, or native MultiEdit for several exact replacements.
5. If the user accepts the local native diff, agent calls `edit_doc` or `multi_edit_doc` with the same `old_string`/`new_string` operation it used locally.
6. Server applies the edit operation against the current canonical Markdown.
7. Server updates the live editor state through the minimal transaction live writer and creates a new version.
8. CLI reports the server outcome with `versionId` and `hash` on success.

Acceptance criteria:

- If `old_string` is absent, API returns `409 old_string_not_found`.
- If `old_string` appears more than once and `replace_all=false`, API returns `409 ambiguous_match`.
- `edit_doc` matching is always against the exact current canonical Markdown string.
- `multi_edit_doc` applies ordered replacements atomically and creates one version. If any replacement fails, none of the edits are persisted.
- Successful edit creates a version with `actor_type='agent'`.
- No in-app AI diff UI is required for approval or review.

### Journey E: AI writes full document

1. Agent calls `read_doc` and receives `base_version_id`, `base_hash`, and Markdown.
2. Agent may call `snapshot create` to materialize a local `proposal.md` for native Codex/Claude Code diff review.
3. Agent rewrites `proposal.md` using a native Write/full-file action.
4. If the user accepts the local native diff, agent calls `write_doc` with `base_version_id`, `base_hash`, and the revised Markdown from `proposal.md`.
5. Server accepts only if current version and hash still match.
6. Server updates live editor state through the minimal transaction live writer and creates a version.
7. CLI reports the server outcome with `versionId` and `hash` on success.

Acceptance criteria:

- Stale full-write returns `409 stale_base_hash` and does not modify the doc.
- Stale full-write version returns `409 stale_base_version` and does not modify the doc.
- Successful full-write creates a version.
- Online users see the update.
- The live writer applies changed ranges through ProseMirror transactions/Yjs updates rather than replacing the entire live document.
- No AI streaming UX, selection-aware AI, or in-app diff UI is required for MVP.

> **Context note:** The first API sketch only checked `base_hash` even though the API request carried `baseVersionId`. The corrected journey uses both fields for full-document overwrite safety.

### Journey F: branch from old version

1. User opens history.
2. User selects an old version.
3. User clicks **Branch from this version**.
4. App creates a new branch whose first live content equals that old version.
5. Main branch remains unchanged.

Acceptance criteria:

- Old versions remain visible.
- The new branch has a separate head.
- Editing one branch does not mutate the other branch.

## Feature requirements

## Visual editor

- Use Milkdown as the human editor.
- Render Markdown tables visually.
- Support headings, lists, links, images, code blocks, blockquotes, tables, and task lists in MVP.
- Support Mermaid/math as fenced blocks if the selected Milkdown plugins handle them reliably; otherwise preserve them as code fences and render in preview/export only.

## Canonical Markdown

- AI always reads canonical Markdown.
- Export always uses canonical Markdown.
- The app can normalize list markers, table spacing, link style, and whitespace.
- The app must not silently drop supported Markdown content.

## Agent tools

Required backend/API tools:

```text
read_doc
write_doc
edit_doc
multi_edit_doc
list_versions
branch_from_version
export_doc
import_doc
manual_save
```

Required CLI-only workflow tools:

```text
snapshot_create
snapshot_status
config
health
```

`snapshot_create` is local-only. It exists so Codex/Claude Code can use native file-edit diff review against `proposal.md`; it is not a database record and not a product export.

Not required in MVP:

```text
insert_doc
approve_edit
reject_edit
stream_ai_response
selection_ai_command
watch_local_file
sync_github
```

## Agent-side diff snapshots

The app does not build an in-app diff approval UI for MVP. Codex, Claude Code, or another CLI/agent should use a local proposal snapshot so native file-edit UI can review proposed changes.

`marklab snapshot create` writes:

```text
.marklab/snapshots/{slug}__SNAPSHOT__doc-{docIdShort}__branch-{branchIdOrSlug}__v{versionNumber}__ver-{versionId}__{yyyyMMdd-HHmmssZ}__sha-{hash8}/
  proposal.md
  metadata.json
```

No `baseline.md`, `before.md`, or `after.md` is created by default. `proposal.md` is initialized with the canonical Markdown returned by `read_doc`; the native agent file-edit UI treats that initial file content as the diff baseline. The Markdown body remains document content only.

The sidecar JSON includes `docId`, `branchId`, `baseVersionId`, `baseVersionNumber`, `baseHash`, `createdAt`, `proposalPath`, and `snapshotRole: "proposal"`.

If the agent locally edits `proposal.md` using a native Edit operation, the online submit should call `edit_doc` with the same `oldString`/`newString`. If it uses native MultiEdit, call `multi_edit_doc` with the same ordered operations. If it uses native Write, call `write_doc` using `proposal.md`.

The CLI does not model user-level accept/reject. If the user rejects the local diff, no write/edit CLI command is called.

## Version and save policy

Human typing:

- Yjs state persists continuously.
- `current_markdown/current_hash` refreshes on a 1-2 second debounce.
- Mirror refresh also flushes on blur, page hide, manual save, export, and agent read/write boundaries.
- No immutable version is created per keystroke.

Version triggers:

- Manual save creates a version immediately when `current_hash` differs from the branch head version hash.
- Autosave creates a version at most once every 10 minutes per dirty active branch, preferably after roughly 30 seconds idle or on blur/page hide.
- Agent write/edit creates a version immediately after the minimal transaction live writer succeeds.
- If an agent write/edit starts while human edits are present in the branch mirror but not yet represented by the head version, the server creates a pre-agent checkpoint version first, then creates the agent version as its child. This prevents older human edits from being silently bundled into an agent-authored version.

## Export

Exported filename format:

```text
{slug}__EXPORT__doc-{docIdShort}__branch-{branchSlug}__v{versionNumber}__{yyyyMMdd-HHmmssZ}__sha-{hash8}__check-cloud-before-use.md
```

Example:

```text
strategy-memo__EXPORT__doc-a13f9c__branch-main__v0043__20260429-153012Z__sha-7b91a2cf__check-cloud-before-use.md
```

This makes it clear that exported local files are snapshots, not the source of truth.

## Non-functional requirements

- 99% of normal Markdown docs under 200 KB should import/export in less than 1 second server-side.
- Realtime editor should remain usable with documents up to 100 KB in MVP.
- The backend must reject stale full writes instead of silently overwriting newer work.
- Every accepted agent write/edit must be auditable through versions.
