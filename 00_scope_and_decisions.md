# Historical cloud-first reference. Superseded by plans/01 through plans/06 local-first product plans.

# Scope and Decisions

## Product scope

Build a cloud-hosted Markdown-native collaborative document for humans and AI coding agents.

Humans edit the document in a WYSIWYG Markdown UI. AI agents read/write canonical Markdown through simple CLI/API tools, with a skill teaching when to preview changes in chat before writing. MCP can be added later as a thin adapter once the CLI/API semantics are stable. Every successful AI write/edit creates an immutable version snapshot. Users can branch from old versions and rollback without destroying discarded history.

## Final MVP scope

### In scope

1. Create cloud Markdown doc from blank content.
2. Create cloud Markdown doc from uploaded local `.md`.
3. Milkdown WYSIWYG editor for humans.
4. Realtime human collaboration using Yjs/Hocuspocus.
5. Basic presence: show connected users.
6. Canonical Markdown mirror for AI/export/versioning.
7. AI `read_doc`, `write_doc`, and `edit_doc` APIs.
8. Safe full-write using `baseVersionId` and `baseHash`.
9. Safe local edit using `oldString -> newString`.
10. Automatic version snapshot after every accepted AI write/edit.
11. Version DAG/branch data model.
12. Simple branch/history UI.
13. Export `.md` with metadata in filename.
14. CLI + agent skill for direct online document tools.
15. Basic share links and agent tokens.
16. Deployment to a persistent WebSocket-capable backend.
17. Real browser document URLs such as `/docs/:docId/branches/:branchId`.
18. Web UI for new document, Markdown import, open existing document, and export.
19. Web UI for version history, branch from version, branch switching, and restore-as-new-version.
20. Controlled MVP admin/bootstrap token for create/import and token management until full accounts exist.

### Out of scope for MVP

1. Local bidirectional file sync.
2. Local watch process.
3. GitHub sync.
4. Full Notion-like workspace/database.
5. In-app AI diff approval UI.
6. AI streaming UX.
7. In-app selection-aware AI commands.
8. Comments/reactions.
9. Complex org/team RBAC.
10. Simultaneously editable raw source editor and visual editor.
11. A separate `insert_doc` tool.
12. Perfect byte-for-byte preservation of arbitrary Markdown input.
13. `Crepe.Feature.AI` as an implementation path; Crepe AI is reference material only.
14. MCP as the first agent integration path. MCP can wrap the stable API/CLI later, but CLI + skill is the MVP agent workflow.
15. Server-side preview/change-set approval workflow.
16. Local proposal snapshot workflow as the default agent path.
17. Public `multi_edit_doc` tool. Multiple coherent changes should use `write_doc`; repeated `edit_doc` calls are only for intentionally separate edits.

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

Canonical Markdown is derived through Milkdown's parser/serializer with the active editor schema, then normalized by the formatter. Prettier-only formatting is not a substitute for Milkdown semantic round-trip. Import and branch-from-version must initialize live Yjs/ProseMirror state from Markdown/version snapshots, not only `current_markdown`.

## AI write model

Use Claude Code-like tools:

```text
read_doc  -> returns markdown + version + hash
write_doc -> guarded full-document Markdown input, requires baseVersionId + baseHash
edit_doc  -> exact oldString/newString replacement against current canonical Markdown, no separate insert tool
```

Accepted `write_doc` and `edit_doc` calls must update the live editor document through a minimal transaction live writer. The writer must parse target canonical Markdown into the editor document model, compare it to the current Yjs-bound ProseMirror document, apply only changed ranges through transactions/Yjs updates, serialize the resulting live document back to canonical Markdown, then update mirror/hash/version state. A mirror-only write or wholesale live-document replacement is not acceptable for MVP.

The model is responsible for explaining proposed changes in chat before calling a write tool when the change is meaningful, broad, risky, or requested for review. The product server does not need a separate preview/change-set workflow in MVP; it only needs deterministic read/edit/write execution, conflict detection, live editor synchronization, and version history.

`insert` is represented by `edit`. Example:

```json
{
  "oldString": "## Risks\n",
  "newString": "## Risks\n\n- New risk introduced by regulation.\n"
}
```

## Version model

Use a DAG/branch model, not destructive rollback.

Rollback or branch-from-version never deletes discarded versions. The user can archive branches or permanently delete leaf versions later, but MVP only needs archive.

Save policy:

```text
Yjs live state persistence:
  continuous/update-based and not user-visible version history

canonical mirror update:
  debounce around 1-2 seconds after human edits
  flush on blur, tab hide, manual save, export, and agent read/write boundaries

manual save:
  create a version immediately if current_hash differs from the head version hash

autosave version:
  create at most once every 10 minutes per dirty active branch
  trigger after roughly 30 seconds idle or on blur/page hide, not per keystroke

pre-agent checkpoint:
  before an agent write/edit, if current_markdown/current_hash has unversioned human edits, create a checkpoint version first

AI write/edit:
  create a version immediately after the minimal transaction live writer succeeds
```

## Local workflow

MVP local workflow is:

```text
local .md -> upload/create cloud doc
cloud doc -> export .md snapshot
```

Local sync is not part of MVP because it adds conflicts, watch processes, sidecar metadata, and unclear source-of-truth semantics.

AI review is primarily a model/runtime behavior, not a MarkLab product workflow. For small, low-risk exact edits, the agent may call `edit_doc` directly after tool permission. For meaningful, large, high-stakes, or user-cautious edits, the agent should first describe the intended change in chat, including a concise before/after excerpt or diff when useful, then call `write_doc` only if the user approves through the agent/tool loop.

CLI commands operate directly on the online document:

```text
marklab read-doc
marklab edit-doc
marklab write-doc
marklab versions
marklab export
marklab import
```

The CLI reports server outcomes such as `written`, `stale_base_version`, `live_yjs_state_changed`, `old_string_not_found`, or `ambiguous_match`. It does not report user-level `accepted` or `rejected` because that decision belongs to Codex/Claude Code's permission and chat loop.

## Web product surface

The browser MVP is not only a local editor harness. It must include:

```text
/docs/:docId/branches/:branchId
  real backend document route backed by Hocuspocus room doc:{docId}:branch:{branchId}

root document shell
  create blank doc
  import local .md
  open existing doc by id/branch
  export current branch as .md snapshot

version and branch panel
  list versions
  preview old version Markdown
  branch from selected version
  switch branch
  restore selected version as a new branch head version

share/access panel
  create edit/view share links
  create read/write agent tokens
  revoke links and tokens

controlled MVP admin/bootstrap
  create/import documents when production auth is enabled
  manage document share links and agent tokens
  replace later with account auth
```

The local single-editor route and `/?collab=two` harness remain useful for editor development and Playwright coverage, but they are not substitutes for product E2E. Product testing must use real document URLs connected to the persistent backend.
