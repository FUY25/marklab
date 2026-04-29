# Risks and Attention Points

## Risk 1: Milkdown round-trip changes Markdown formatting

Impact:

- AI old_string matching can fail if formatting changes unexpectedly.
- Export may look different from imported Markdown.

Mitigation:

- Treat canonical Markdown as the standard output.
- Use deterministic formatter.
- Run fixture tests before accepting Milkdown configuration.
- Tell users export is canonical, not byte-preserved.

## Risk 2: Server-side Milkdown transformation may be awkward

Impact:

- AI writes must update live ProseMirror/Yjs state.
- If the transformer requires browser APIs, server code may need `jsdom` or a worker.

Mitigation:

- Do an early Milkdown transformer spike.
- If server-side transform is unreliable, use a small headless browser/worker transformation service.
- Keep the API contract independent of the implementation.

## Risk 3: Directly editing `current_markdown` can desync live editors

Impact:

- Online users may not see AI writes.
- Collaboration persistence may overwrite AI writes.

Mitigation:

- All accepted writes must update collaborative state and mirror together.
- Add integration tests where an online editor receives an API edit.
- Require the minimal transaction live writer to apply changed ranges through ProseMirror transactions/Yjs updates before mirror/hash/version updates.

> **Context note:** The first AI route plan allowed a mirror-only update as an implementation seam. That has been removed from the executable API plan because it is the exact failure mode described here.

## Risk 4: Editable source and visual editor simultaneously creates complexity

Impact:

- Cursor mapping and undo history can break.
- Markdown text offsets and ProseMirror positions differ.

Mitigation:

- MVP does not include simultaneous editable source/split.
- Source panel, if present, is read-only export/debug output.
- Cursor position and selection-aware AI are not MVP requirements.

## Risk 5: AI full write overwrites human edits

Impact:

- Lost human work.

Mitigation:

- `write_doc` requires exact `baseVersionId` and `baseHash` equality.
- Reject stale writes.
- `edit_doc` targets `old_string` and rejects absent/ambiguous matches.

## Risk 6: In-app AI diff UI slows MVP

Impact:

- AI review work expands into streaming UX, selection state, and approval UI before the write path is reliable.
- The app may duplicate workflows that Codex/Claude Code already handle well with native file-edit diffs.

Mitigation:

- Do not build in-app AI diff UI, AI streaming UX, or in-app selection-aware AI for MVP.
- Use `marklab snapshot create` to materialize one local `proposal.md` plus `metadata.json`.
- Let Codex/Claude Code own local accept/reject through native file-edit review.
- Submit the same semantic operation online: native Edit -> `edit_doc`, native MultiEdit -> `multi_edit_doc`, native Write -> `write_doc`.

## Risk 6a: CLI submits a different action than the reviewed local action

Impact:

- The user reviews one local diff but the server receives a different write shape.
- A targeted edit can accidentally become a broad full-document replacement, or multiple edits can produce partial versions.

Mitigation:

- The MarkLab skill must instruct agents to mirror the local native action when submitting online.
- `multi_edit_doc` should apply ordered replacements atomically and create one version.
- Do not infer `edit_doc` from a whole-file diff as the default path.
- `snapshot_create` is review-only and has no accept/reject or submit semantics.

## Risk 7: Version tree UI becomes too complex

Impact:

- Product slows down before core AI-writing loop is validated.

Mitigation:

- Back end stores DAG.
- Front end starts with simple list grouped by branch.
- Advanced graph visualization is not in MVP.

## Risk 8: Local sync distracts from core product

Impact:

- Adds conflicts and source-of-truth confusion.

Mitigation:

- MVP only imports local `.md` and exports snapshots.
- Export filename says `EXPORT` and `check-cloud-before-use`.

## Risk 8a: MCP built before the CLI workflow creates a weak agent experience

Impact:

- MCP exposes tools but does not guarantee agents follow the local proposal review, stale guard, and semantic action mirroring policy.
- Early MCP work can obscure whether the CLI/skill loop actually works for Codex and Claude Code.

Mitigation:

- Build MarkLab CLI + agent skill first.
- Keep MCP as a later thin adapter over the same API or CLI commands.
- If MCP is added, tool descriptions must point agents back to the same skill workflow instead of inventing a parallel write policy.

## Risk 9: WebSocket deployment on serverless platform

Impact:

- Realtime collaboration fails or requires extra provider services.

Mitigation:

- Deploy Hocuspocus on a persistent Node backend.
- Use Cloudflare/Vercel only for frontend/CDN unless using a proven realtime service.
