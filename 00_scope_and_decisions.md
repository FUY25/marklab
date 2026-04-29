# Scope and Decisions

## Product scope

Build a cloud-hosted Markdown-native collaborative document for humans and AI coding agents.

Humans edit the document in a WYSIWYG Markdown UI. AI agents read/write canonical Markdown through API and a local CLI/skill workflow, with MCP as a later adapter once the workflow is stable. Every successful AI write/edit creates an immutable version snapshot. Users can branch from old versions and rollback without destroying discarded history.

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
9. Safe local edit using `old_string -> new_string`.
10. Atomic multi-edit for ordered `old_string -> new_string` replacements.
11. Automatic version snapshot after every accepted AI write/edit.
12. Version DAG/branch data model.
13. Simple branch/history UI.
14. Export `.md` with metadata in filename.
15. CLI + agent skill for local proposal review and online submission.
16. Basic share links and agent tokens.
17. Deployment to a persistent WebSocket-capable backend.

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
write_doc -> guarded full-document Markdown input, requires baseVersionId + baseHash
edit_doc  -> exact old_string/new_string replacement against canonical Markdown, no separate insert tool
multi_edit_doc -> ordered exact replacements applied atomically as one version
```

Accepted `write_doc` and `edit_doc` calls must update the live editor document through a minimal transaction live writer. The writer must parse target canonical Markdown into the editor document model, compare it to the current Yjs-bound ProseMirror document, apply only changed ranges through transactions/Yjs updates, serialize the resulting live document back to canonical Markdown, then update mirror/hash/version state. A mirror-only write or wholesale live-document replacement is not acceptable for MVP.

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

AI review uses local CLI/agent proposal snapshots instead of in-app diff UI. `marklab snapshot create` writes a single editable `proposal.md` plus `metadata.json`; it does not write `baseline.md`, `before.md`, or `after.md`. Codex/Claude Code native file-edit review owns accept/reject. If the user rejects the local diff, no MarkLab write/edit command is called.

The local action and online action should have the same semantics:

```text
native Edit of proposal.md      -> marklab edit_doc with the same oldString/newString
native MultiEdit of proposal.md -> marklab multi_edit_doc with the same ordered edit ops
native Write of proposal.md     -> marklab write_doc from proposal.md
```

The CLI reports server outcomes such as `written`, `stale`, `old_string_not_found`, or `ambiguous_match`. It does not report user-level `accepted` or `rejected` because that decision belongs to Codex/Claude Code's local review loop.
