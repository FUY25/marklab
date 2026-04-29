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
REST/MCP backend
  read/write/edit/export/version APIs
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
  -> update collaboration document state
  -> serialize to canonical Markdown
  -> update mirror
  -> create version
  -> broadcast to clients
```

> **Context note:** The original AI API implementation sketch updated `current_markdown` directly as a temporary seam. That path is removed from the executable plan because it can desync online editors. The collaboration document state must change first, and the mirror/version must be derived from that updated live state.

Implementation options:

1. Use Hocuspocus `openDirectConnection` when the document state can be modified server-side.
2. If Milkdown/ProseMirror transformations are easier client-side, use a headless transformer service with `jsdom` to convert Markdown to editor state. The server still owns the transaction and persistence.

## Branch-aware rooms

Each branch is a separate collaboration room.

```text
room name = doc:{docId}:branch:{branchId}
```

This avoids merging branches accidentally.

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
