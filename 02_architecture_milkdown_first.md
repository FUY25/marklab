# Architecture Design — Milkdown-first

## High-level architecture

```text
Browser
  Milkdown visual editor
  ProseMirror document state
  Yjs collaboration binding
  Hocuspocus provider
        |
        | WebSocket
        v
Realtime backend
  Hocuspocus server
  Y.Doc per doc branch
  persistence hooks
        |
        v
Postgres
  branch Yjs binary state
  canonical Markdown mirror
  version snapshots
  share links / agent tokens
        ^
        |
REST backend
  read/write/edit/export/version APIs
        ^
        |
MarkLab CLI + agent skill
  direct online document tools and agent policy guidance
        ^
        |
Optional MCP adapter
  later wrapper over the same API/CLI semantics
```

## Design principle

Humans interact with a polished visual editor. AI agents interact with canonical Markdown. The system bridges the two using Milkdown’s Markdown/ProseMirror transformation pipeline and a canonical Markdown mirror.

## Runtime state

### Live editor state

Live collaboration is stored as Yjs/ProseMirror state.

```text
branch_state.yjs_state bytea
```

This is the primary realtime collaboration state.

### Canonical Markdown mirror

The API/export/version layer uses:

```text
branch_state.current_markdown text
branch_state.current_hash text
```

This mirror is updated after user edits and after agent writes.

> **Context note:** The first backend persistence sketch stored only Yjs binary state in Hocuspocus hooks. That is not enough to keep this mirror fresh because Hocuspocus does not have Milkdown's Markdown serializer. Human-edit mirror refresh must come from a Milkdown serialization path, such as a debounced browser listener or a verified headless Milkdown transformer service.

The mirror is derived state. For supported Markdown, the authoritative semantic path is:

```text
Yjs/ProseMirror live doc
  -> Milkdown serializer
  -> canonical Markdown formatter
  -> current_markdown/current_hash
  -> versions/export/read_doc
```

Prettier can stabilize whitespace after Milkdown serialization, but it must not replace Milkdown's parser/serializer as the semantic conversion layer.

### Immutable versions

Each version stores a complete canonical Markdown snapshot.

```text
versions.markdown_snapshot text
```

MVP uses full snapshots. Compression/delta storage is a later optimization.

## Why not raw Markdown Y.Text?

Because we chose Milkdown-first. Milkdown’s visual editing uses a ProseMirror document model. Raw Markdown remains the product interchange format, not the only live editor state.

## Why not direct DB writes for AI?

AI writes must update the live collaborative state, not just `current_markdown` in the database. Otherwise, online editors can display stale content or overwrite the AI write on the next persistence cycle.

Correct path:

```text
AI write/edit API
  -> validate against current_markdown/hash
  -> compute target canonical Markdown
  -> parse target Markdown to editor document
  -> compare with current Yjs-bound ProseMirror document
  -> apply only changed ranges through transactions/Yjs updates
  -> serialize live document back to canonical Markdown
  -> update mirror/hash
  -> create version
  -> broadcast to clients
```

> **Context note:** The original AI API implementation sketch updated `current_markdown` directly as a temporary seam. That path is removed from the executable plan because it can desync online editors. The collaboration document state must change first, and the mirror/version must be derived from that updated live state.

## Minimal transaction live writer

The AI write path must use a live editor writer, not a mirror-only writer. It also must not use whole-document replacement as the MVP behavior.

Required flow:

```text
target canonical Markdown
  -> parse to Milkdown/ProseMirror document with the branch schema
  -> read the current live Yjs-bound ProseMirror document
  -> compare target doc to current doc
  -> dispatch ProseMirror transactions for only the changed ranges
  -> let Yjs publish/persist those updates
  -> serialize the resulting live doc back to canonical Markdown
  -> update current_markdown/current_hash/head version from serialized live doc
```

This keeps online editors on the same state path as human collaboration. The diffing granularity only needs to be reliable enough for changed block/range transactions in MVP; it does not need cursor preservation or selection-aware AI behavior.

If a branch's live Yjs document is empty but `current_markdown` is non-empty, the writer must first seed the live Yjs/ProseMirror document from `current_markdown` through the same Milkdown parser/Yjs path, then apply the target diff. This guards imports and branch-from-version flows where no browser has opened the branch yet.

Implementation options:

1. Use Hocuspocus `openDirectConnection` when the document state can be modified server-side and transactions can be applied against the live Yjs-bound ProseMirror document.
2. If Milkdown/ProseMirror transformations are easier client-side, use a headless transformer service with `jsdom` to parse target Markdown, compare documents, dispatch transactions, and serialize the resulting live state. The server still owns validation, persistence, and version creation.

`Crepe.Feature.AI` is not part of the execution path. Its streaming and diff UI can be studied later as reference material only.

## Branch-aware rooms

Each branch is a separate collaboration room.

```text
room name = doc:{docId}:branch:{branchId}
```

This avoids merging branches accidentally.

## Import and branch initialization

Import and branch-from-version must initialize both durable representations:

```text
source Markdown/version snapshot
  -> Milkdown parser with the active editor schema
  -> ProseMirror document
  -> Yjs prosemirror XML fragment
  -> encoded yjs_state
  -> Milkdown serializer
  -> canonical Markdown mirror/hash
  -> initial version
```

The preferred implementation is a headless Milkdown transformer service that produces valid Yjs state during import and branch creation. If MVP execution cannot make that transformer reliable immediately, the live writer must include an explicit seed-if-empty fallback before applying AI writes. Relying on the first browser editor opening `applyTemplate(initialMarkdown)` is not sufficient because agents may write before any human opens the branch.

## API topology

```text
POST   /api/docs
POST   /api/docs/import
GET    /api/docs/:docId/branches/:branchId/read
POST   /api/docs/:docId/branches/:branchId/write
POST   /api/docs/:docId/branches/:branchId/edit
GET    /api/docs/:docId/branches/:branchId/export.md
GET    /api/docs/:docId/versions
POST   /api/docs/:docId/versions/:versionId/branch
POST   /api/docs/:docId/branches/:branchId/rollback
```

## Deployment topology

Recommended MVP:

```text
Frontend: Next.js static/server app
Realtime/API backend: Node.js process on Fly.io/Railway/Render/DigitalOcean/AWS
Database: Postgres
Optional edge/CDN: Cloudflare DNS/CDN
```

Do not rely on Vercel Serverless Functions for the WebSocket collaboration server because Vercel Functions do not act as WebSocket servers.

## Cloudflare role

Cloudflare is optional:

- Good for DNS, CDN, SSL, WAF.
- Cloudflare Durable Objects are promising for future per-doc realtime state.
- Cloudflare Tunnel is useful for demos/local development.
- MVP should use a conventional persistent Node backend first.

## Editor package strategy

Use these packages as the initial direction:

```text
@milkdown/kit
@milkdown/react
@milkdown/plugin-collab
yjs
@hocuspocus/provider
@hocuspocus/server
prosemirror-model
prettier
zod
```

The exact Milkdown package shape should be verified in the spike because Milkdown APIs evolve. The spike locks the import paths and integration pattern before feature work starts.
