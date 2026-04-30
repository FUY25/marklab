# Product Requirements

## Primary personas

### Human collaborator

A researcher, founder, strategist, or engineer writing a shared Markdown document with teammates in a browser.

### AI coding/research agent

Claude Code, Codex, or another agent that needs to read and write the shared document without using the visual UI. The MVP integration path is MarkLab CLI + a MarkLab agent skill. MCP is a later adapter, not the first workflow.

## Core user journeys

### Journey A: create from blank

1. User opens the app.
2. User clicks **New Markdown Doc**.
3. App creates `doc_id` and default `main` branch.
4. App opens `/docs/:docId/branches/:branchId`.
5. User edits in Milkdown visual editor.
6. System updates collaboration state and canonical Markdown mirror.
7. User exports `.md` if needed.

Acceptance criteria:

- The document persists after refresh.
- A second browser can join the same doc and see edits in realtime.
- Exported Markdown contains the current document content.
- User does not need to manually paste API ids after creating the doc.

### Journey B: create from local Markdown

1. User uploads `strategy.md`.
2. App parses the Markdown through Milkdown with the active editor schema.
3. App initializes the branch's ProseMirror/Yjs state from the parsed document.
4. App serializes that editor state back to Markdown and applies the canonical formatter.
5. App creates a cloud doc from the canonical Markdown.
6. App opens `/docs/:docId/branches/:branchId`.
7. Milkdown renders the content visually.
8. App records version `v1` with operation `import`.

Acceptance criteria:

- Supported headings, lists, tables, code fences, links, images, blockquotes, math fences, Mermaid fences, and YAML frontmatter survive import/export semantically.
- The exported file is named with doc/version/date/hash metadata.
- The Markdown body is not modified to add app metadata by default.
- Import is available through Web UI, not only API/CLI.

### Journey C: human collaboration

1. Owner creates an edit link.
2. Teammate opens the same `/docs/:docId/branches/:branchId` URL or an edit share link for that route.
3. Both users edit the visual document.
4. Both see the same final content.
5. Presence shows both users connected.

Acceptance criteria:

- Concurrent edits converge.
- No user must manually refresh.
- Presence does not need cursor or selection fidelity in MVP, but connected collaborators should be visible.
- The same behavior works across two browser windows, not only inside the `/?collab=two` local harness.

### Journey D: AI reads and edits

1. User creates an agent token for a doc/branch.
2. Agent calls `read_doc` and receives canonical Markdown, version, and hash.
3. For a small, low-risk, localized edit, agent calls `edit_doc` with an exact `oldString -> newString` replacement.
4. Claude Code/Codex tool permission asks the user before the CLI/API write runs, according to the user's agent settings.
5. Server applies the edit operation against the current canonical Markdown.
6. Server updates the live editor state through the minimal transaction live writer and creates a new version.
7. CLI reports the server outcome with `versionId` and `hash` on success.

Acceptance criteria:

- If `oldString` is absent, API returns `409 old_string_not_found`.
- If `oldString` appears more than once and `replaceAll=false`, API returns `409 ambiguous_match`.
- `edit_doc` matching is always against the exact current canonical Markdown string.
- Successful edit creates a version with `actor_type='agent'`.
- No in-app AI diff UI, local snapshot, or server-side preview/change-set workflow is required for approval or review.

### Journey E: AI writes full document

1. Agent calls `read_doc` and receives `versionId`, `hash`, and Markdown. The agent sends those values back to `write_doc` as `baseVersionId` and `baseHash`.
2. For broad, meaningful, multi-location, high-stakes, or user-cautious changes, agent explains the proposed change in chat before writing. It should include a concise before/after excerpt or diff when that helps review.
3. If the user proceeds through the agent/tool permission loop, agent calls `write_doc` with `baseVersionId`, `baseHash`, and the full target Markdown.
4. Server accepts only if the branch head version and freshly serialized live Yjs hash still match the submitted base.
5. Server updates live editor state through the minimal transaction live writer and creates a version.
6. CLI reports the server outcome with `versionId` and `hash` on success.

Acceptance criteria:

- Full-write after newer live edits returns `409 live_yjs_state_changed` and does not modify the doc.
- Stale full-write version returns `409 stale_base_version` and does not modify the doc.
- Successful full-write creates a version.
- Online users see the update.
- The live writer applies changed ranges through ProseMirror transactions/Yjs updates rather than replacing the entire live document.
- No AI streaming UX, selection-aware AI, in-app diff UI, server-side change-set approval, or local proposal snapshot is required for MVP.

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

### Journey G: restore old version as new head

1. User opens history.
2. User previews an old version.
3. User clicks **Restore as new version**.
4. App creates a new version on the current branch whose content equals the selected old version.
5. Older versions remain in history.

Acceptance criteria:

- Restore does not delete history.
- Restore creates a version with operation `rollback`.
- Connected browsers update to the restored content without refresh.

### Journey H: share with human and agent

1. User enters the controlled MVP admin token for the current browser session.
2. User opens share/access panel.
3. User creates an edit or view share link.
4. User creates an agent token with read or write permission.
5. User copies the raw token once at creation.
6. User can revoke the token/link.

Acceptance criteria:

- Raw tokens are not shown after creation.
- Read-only links/tokens cannot write.
- Revoked or expired links/tokens cannot read, write, or connect to the collaboration room.
- Production mode rejects unauthenticated document access.
- Production mode rejects unauthenticated create/import and token management.
- Admin token is session-scoped in the browser and is not stored as a raw database value.

## Feature requirements

## Visual editor

- Use Milkdown as the human editor.
- Render Markdown tables visually.
- Support headings, lists, links, images, code blocks, blockquotes, tables, and task lists in MVP.
- Support Mermaid/math as fenced blocks if the selected Milkdown plugins handle them reliably; otherwise preserve them as code fences and render in preview/export only.
- Product document route is `/docs/:docId/branches/:branchId` and uses a Hocuspocus-backed Y.Doc, not a local-only Y.Doc.

## Web document shell

- Root route exposes New Markdown Doc, Import Markdown, Open existing document, and recent documents.
- Create/import navigates directly to the real document URL.
- Export is available from the document toolbar and uses the server-provided versioned filename.
- API/export errors are visible to the user.
- Local editor harness routes stay available for development and testing.

## Web version and branch UI

- Version history is visible in the browser.
- Users can preview old version Markdown.
- Users can branch from an old version.
- Users can switch branches.
- Users can restore an old version as a new version on the current branch.
- Advanced graph visualization is not required in MVP.

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
list_versions
branch_from_version
export_doc
import_doc
manual_save
```

Required CLI-only workflow tools:

```text
config
health
```

Required Web-only controls:

```text
new_doc
import_markdown_file
open_doc_by_id
export_markdown_file
copy_doc_link
list_versions_panel
branch_from_version_button
restore_version_button
create_share_link
create_agent_token
revoke_share_link_or_token
```

Not required in MVP:

```text
insert_doc
multi_edit_doc
approve_edit
reject_edit
stream_ai_response
selection_ai_command
watch_local_file
sync_github
server_preview_change
apply_change_set
snapshot_create
```

## Agent review policy

The app does not build an in-app diff approval UI for MVP. The model and agent runtime own proposal explanation, review text, and tool permission.

Use `edit_doc` only when the change is a single exact replacement affecting one small local region. Use `write_doc` when the change affects multiple regions, changes structure, rewrites prose, deletes content, or cannot be represented as one exact `oldString/newString` replacement.

Before calling `write_doc`, the agent skill must instruct the model to explain the proposed change in chat. For high-stakes or meaningful changes, include a concise diff or before/after excerpt. If the user asks to review first, force this path.

## Version and save policy

Human typing:

- Yjs state persists continuously.
- `current_markdown/current_hash` refreshes on a 1-2 second debounce.
- Mirror refresh uses Milkdown serializer output plus canonical formatting, and also flushes on blur, page hide, manual save, export, and agent read/write boundaries.
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
- Browser users must be able to exercise the full create/import/edit/version/export path without using raw API calls.
