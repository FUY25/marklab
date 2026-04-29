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

> **Context note:** The first AI route plan allowed a mirror-only update as an implementation seam. That has been removed from the executable API plan because it is the exact failure mode described here.

## Risk 4: Editable source and visual editor simultaneously creates complexity

Impact:

- Cursor mapping and undo history can break.
- Markdown text offsets and ProseMirror positions differ.

Mitigation:

- MVP does not include simultaneous editable source/split.
- Source panel, if present, is read-only export/debug output.

## Risk 5: AI full write overwrites human edits

Impact:

- Lost human work.

Mitigation:

- `write_doc` requires `base_hash` equality.
- Reject stale writes.
- `edit_doc` targets `old_string` and rejects absent/ambiguous matches.

## Risk 6: Version tree UI becomes too complex

Impact:

- Product slows down before core AI-writing loop is validated.

Mitigation:

- Back end stores DAG.
- Front end starts with simple list grouped by branch.
- Advanced graph visualization is not in MVP.

## Risk 7: Local sync distracts from core product

Impact:

- Adds conflicts and source-of-truth confusion.

Mitigation:

- MVP only imports local `.md` and exports snapshots.
- Export filename says `EXPORT` and `check-cloud-before-use`.

## Risk 8: WebSocket deployment on serverless platform

Impact:

- Realtime collaboration fails or requires extra provider services.

Mitigation:

- Deploy Hocuspocus on a persistent Node backend.
- Use Cloudflare/Vercel only for frontend/CDN unless using a proven realtime service.
