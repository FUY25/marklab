# Historical cloud-first reference. Superseded by plans/01 through plans/06 local-first product plans.

# Risks and Attention Points

## Risk 1: Milkdown round-trip changes Markdown formatting

Impact:

- AI `oldString` matching can fail if formatting changes unexpectedly.
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

## Risk 3a: Import or branch creates Markdown mirror without live Yjs content

Impact:

- An imported or branch-from-version document can look correct in `read_doc`/export but have an empty collaborative editor state until a browser opens it.
- AI writes before first browser open can diff against an empty live doc and overwrite or misapply content.

Mitigation:

- Prefer initializing import and branch state through a headless Milkdown parser/serializer/Yjs transformer.
- If that transformer is not reliable in the first implementation slice, require the minimal transaction live writer to seed empty Yjs state from `current_markdown` before applying AI writes.
- Test both imported docs and branch-from-version docs before any browser opens them.

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
- `edit_doc` targets `oldString` and rejects absent/ambiguous matches.

## Risk 6: In-app AI diff UI slows MVP

Impact:

- AI review work expands into streaming UX, selection state, and approval UI before the write path is reliable.
- The app may duplicate workflows that Codex/Claude Code already handle well with chat explanations, tool permission, and optional local diffs.

Mitigation:

- Do not build in-app AI diff UI, AI streaming UX, or in-app selection-aware AI for MVP.
- Let Codex/Claude Code own proposal explanation, user review, and tool permission.
- Use `edit_doc` only for one small exact replacement.
- Use `write_doc` for broad, meaningful, multi-region, destructive, or high-stakes changes after the agent explains the proposed change in chat.

## Risk 6a: Tool surface becomes too clever

Impact:

- Server-side preview/change-set state or public multi-edit tools add workflow complexity before the core live writer is proven.
- A larger API surface gives agents more ways to choose the wrong operation.

Mitigation:

- Keep the MVP public tools to `read_doc`, `edit_doc`, and `write_doc`.
- Do not add `preview_doc_change`, `apply_doc_change`, `change_sets`, default local snapshots, or public `multi_edit_doc` in MVP.
- Let the model generate preview explanations in chat; let the server focus on deterministic execution, conflict detection, live synchronization, and version history.

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

- MCP exposes tools but does not guarantee agents follow the simple edit/write routing policy, stale guard, and review-before-broad-write guidance.
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

## Risk 10: Web app remains a local harness instead of product UI

Impact:

- Tests can pass against `/?collab=two` while the actual product cannot open a real backend document.
- API/agent writes may be verified in backend tests but never proven visible in connected browsers.

Mitigation:

- Add `/docs/:docId/branches/:branchId` before Plan 7.
- Require Playwright E2E that imports a backend doc, opens two browser contexts, and verifies browser-to-browser and API-to-browser updates.
- Keep local harnesses for editor development, but do not count them as product E2E.

## Risk 11: Versioning exists only as backend state

Impact:

- Users cannot understand or recover from AI writes.
- Branching is technically available but not usable in the product.

Mitigation:

- Add a simple list-based version panel.
- Show operation, actor type, created time, and hash prefix.
- Support preview, branch from version, branch switch, and restore-as-new-version.
- Defer graph visualization until after MVP.

## Risk 12: Access control is deferred too long

Impact:

- A deployed document API or WebSocket room may be publicly writable.
- CLI/agent workflows may rely on out-of-band tokens that the product cannot create or revoke.

Mitigation:

- Implement document-scoped share links and agent tokens before public deployment.
- Require a controlled MVP admin/bootstrap token for create/import and token management until full accounts exist.
- Hash tokens at rest and show raw tokens only once.
- Gate REST and Hocuspocus access in production with `MARKLAB_REQUIRE_AUTH=true`.
