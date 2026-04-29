# Scope and Decisions

## Product scope

Build a cloud-hosted Markdown-native collaborative document for humans and AI coding agents.

Humans edit the document in a WYSIWYG Markdown UI. AI agents read/write canonical Markdown through API/MCP tools. Every successful AI write/edit creates an immutable version snapshot. Users can branch from old versions and rollback without destroying discarded history.

## Final MVP scope

### In scope

1. Create cloud Markdown doc from blank content.
2. Create cloud Markdown doc from uploaded local `.md`.
3. Milkdown WYSIWYG editor for humans.
4. Realtime human collaboration using Yjs/Hocuspocus.
5. Basic presence: show connected users.
6. Canonical Markdown mirror for AI/export/versioning.
7. AI `read_doc`, `write_doc`, and `edit_doc` APIs.
8. Safe full-write using `base_hash`.
9. Safe local edit using `old_string -> new_string`.
10. Automatic version snapshot after every accepted AI write/edit.
11. Version DAG/branch data model.
12. Simple branch/history UI.
13. Export `.md` with metadata in filename.
14. Basic share links and agent tokens.
15. Deployment to a persistent WebSocket-capable backend.

### Out of scope for MVP

1. Local bidirectional file sync.
2. Local watch process.
3. GitHub sync.
4. Full Notion-like workspace/database.
5. In-app AI diff approval UI.
6. Comments/reactions.
7. Complex org/team RBAC.
8. Simultaneously editable raw source editor and visual editor.
9. A separate `insert_doc` tool.
10. Perfect byte-for-byte preservation of arbitrary Markdown input.

## Editor decision

Use **Milkdown-first**.

Rationale:

- Milkdown is a WYSIWYG Markdown editor built on ProseMirror and Remark.
- Milkdown supports collaborative editing through Yjs.
- The product now prioritizes a polished visual online Markdown editor over raw source editing.
- AI can still interact through canonical Markdown; it does not need to see ProseMirror state.

## Markdown truth model

Use this truth hierarchy:

```text
Runtime collaboration truth:
  Yjs/ProseMirror editor state

Product/API/export truth:
  canonical Markdown mirror

Versioning truth:
  immutable canonical Markdown snapshots
```

The app does not promise byte-level preservation of uploaded Markdown. It promises stable semantic Markdown and a predictable canonical export format.

## AI write model

Use Claude Code-like tools:

```text
read_doc  -> returns markdown + version + hash
write_doc -> full markdown replacement, guarded by base_hash
edit_doc  -> old_string/new_string replacement, no separate insert tool
```

`insert` is represented by `edit`. Example:

```json
{
  "old_string": "## Risks\n",
  "new_string": "## Risks\n\n- New risk introduced by regulation.\n"
}
```

## Version model

Use a DAG/branch model, not destructive rollback.

Rollback or branch-from-version never deletes discarded versions. The user can archive branches or permanently delete leaf versions later, but MVP only needs archive.

## Local workflow

MVP local workflow is:

```text
local .md -> upload/create cloud doc
cloud doc -> export .md snapshot
```

Local sync is not part of MVP because it adds conflicts, watch processes, sidecar metadata, and unclear source-of-truth semantics.
