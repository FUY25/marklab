# Product Requirements

## Primary personas

### Human collaborator

A researcher, founder, strategist, or engineer writing a shared Markdown document with teammates in a browser.

### AI coding/research agent

Claude Code, Codex, or another MCP-capable agent that needs to read and write the shared document without using the visual UI.

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
- Presence does not need perfect cursor visualization in MVP, but connected collaborators should be visible.

### Journey D: AI reads and edits

1. User creates an agent token for a doc/branch.
2. Agent calls `read_doc` and receives canonical Markdown, version, and hash.
3. Agent decides on a change after its own diff/review loop.
4. Agent calls `edit_doc` with `old_string` and `new_string`.
5. Server applies the edit if `old_string` uniquely exists in the current canonical Markdown.
6. Server updates the live editor state and creates a new version.

Acceptance criteria:

- If `old_string` is absent, API returns `409 old_string_not_found`.
- If `old_string` appears more than once and `replace_all=false`, API returns `409 ambiguous_match`.
- Successful edit creates a version with `actor_type='agent'`.

### Journey E: AI writes full document

1. Agent calls `read_doc` and receives `base_hash`.
2. Agent produces a full revised Markdown document after external approval/review.
3. Agent calls `write_doc` with `base_version_id`, `base_hash`, and revised Markdown.
4. Server accepts only if current version and hash still match.
5. Server updates live editor state and creates a version.

Acceptance criteria:

- Stale full-write returns `409 stale_base_hash` and does not modify the doc.
- Stale full-write version returns `409 stale_base_version` and does not modify the doc.
- Successful full-write creates a version.
- Online users see the update.

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

Required:

```text
read_doc
write_doc
edit_doc
list_versions
branch_from_version
export_doc
```

Not required in MVP:

```text
insert_doc
approve_edit
reject_edit
watch_local_file
sync_github
```

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
