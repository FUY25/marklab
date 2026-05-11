# Historical cloud-first reference. Superseded by docs/appdesigndoc.md; previous local-first plans are archived under docs/Archive/local-first-plans/.

# Data Model and API

## Tables

### documents

```sql
create table documents (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  title text not null default 'Untitled',
  default_branch_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

### document_branches

```sql
create table document_branches (
  id uuid primary key default gen_random_uuid(),
  doc_id uuid not null references documents(id) on delete cascade,
  name text not null,
  slug text not null,
  head_version_id uuid,
  created_from_version_id uuid,
  is_archived boolean not null default false,
  created_at timestamptz not null default now(),
  unique (doc_id, slug)
);
```

### document_branch_states

```sql
create table document_branch_states (
  branch_id uuid primary key references document_branches(id) on delete cascade,
  yjs_state bytea not null,
  current_markdown text not null,
  current_hash text not null,
  updated_at timestamptz not null default now()
);
```

> **Context note:** The original implementation plans initialized `yjs_state` with empty bytes and allowed direct `current_markdown` updates. `yjs_state` must be a valid encoded Yjs update, and `current_markdown/current_hash` must be refreshed only after the live Milkdown/Yjs state has been updated or serialized. Direct mirror-only writes are a known desync bug.

### document_versions

```sql
create table document_versions (
  id uuid primary key default gen_random_uuid(),
  doc_id uuid not null references documents(id) on delete cascade,
  branch_id uuid not null references document_branches(id) on delete cascade,
  parent_version_id uuid references document_versions(id),
  version_number integer not null,
  markdown_snapshot text not null,
  hash text not null,
  actor_type text not null check (actor_type in ('user', 'agent', 'system')),
  actor_id text,
  operation text not null check (operation in ('create', 'import', 'autosave', 'manual_save', 'write', 'edit', 'rollback', 'branch')),
  created_at timestamptz not null default now(),
  unique (branch_id, version_number)
);
```

### agent_tokens

```sql
create table agent_tokens (
  id uuid primary key default gen_random_uuid(),
  doc_id uuid not null references documents(id) on delete cascade,
  branch_id uuid references document_branches(id) on delete cascade,
  token_hash text not null,
  name text not null,
  can_read boolean not null default true,
  can_write boolean not null default false,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
```

### share_links

```sql
create table share_links (
  id uuid primary key default gen_random_uuid(),
  doc_id uuid not null references documents(id) on delete cascade,
  branch_id uuid references document_branches(id) on delete cascade,
  token_hash text not null,
  role text not null check (role in ('view', 'edit')),
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
```

## Shared TypeScript types

```ts
export type ActorType = 'user' | 'agent' | 'system';

export type VersionOperation =
  | 'create'
  | 'import'
  | 'autosave'
  | 'manual_save'
  | 'write'
  | 'edit'
  | 'rollback'
  | 'branch';

export interface ReadDocResponse {
  docId: string;
  branchId: string;
  versionId: string;
  versionNumber: number;
  hash: string;
  markdown: string;
}

export interface WriteDocRequest {
  baseVersionId: string;
  baseHash: string;
  markdown: string;
}

export interface EditDocRequest {
  observedVersionId?: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}
```

`ReadDocResponse.hash` is the current canonical mirror hash returned to agents as `baseHash`. `ReadDocResponse.versionId` is the branch head version used as `baseVersionId`. Before returning, `read_doc` flushes live Milkdown/Yjs state through the canonical serializer path; if the flushed mirror hash differs from the branch head version hash, it creates or selects a matching system autosave version so the returned `versionId` and `hash` describe the same Markdown body.

`write_doc` uses `baseVersionId` and `baseHash` as hard stale-write guards against the current branch head and the freshly serialized live Milkdown/Yjs state. If the live serialized hash differs from the submitted `baseHash`, the write is rejected and the agent must call `read_doc` again before producing a new full-document target. `edit_doc` is a Claude-like exact string replacement against the current canonical Markdown; `observedVersionId` is optional audit context and is not a stale guard by default.

## API contracts

### Create blank doc

```http
POST /api/docs
```

Request:

```json
{
  "title": "Strategy memo"
}
```

### Document summary

```http
GET /api/docs/:docId
```

Response:

```json
{
  "docId": "doc_abc",
  "title": "Strategy memo",
  "defaultBranchId": "br_main",
  "branches": [
    {
      "branchId": "br_main",
      "name": "Main",
      "slug": "main",
      "headVersionId": "ver_043",
      "headVersionNumber": 43,
      "createdFromVersionId": null,
      "isArchived": false
    }
  ]
}
```

This route supports the Web document shell, branch switcher, and version UI. It is not an agent write primitive.

### Branch list

```http
GET /api/docs/:docId/branches
```

Response:

```json
{
  "branches": [
    {
      "branchId": "br_main",
      "name": "Main",
      "slug": "main",
      "headVersionId": "ver_043",
      "headVersionNumber": 43,
      "createdFromVersionId": null,
      "isArchived": false
    }
  ]
}
```

Response:

```json
{
  "docId": "doc_abc",
  "branchId": "br_main",
  "versionId": "ver_001",
  "hash": "sha256:..."
}
```

### Import local Markdown

```http
POST /api/docs/import
```

Request:

```json
{
  "title": "Strategy memo",
  "markdown": "# Strategy memo\n\n..."
}
```

Response:

```json
{
  "docId": "doc_abc",
  "branchId": "br_main",
  "versionId": "ver_001",
  "hash": "sha256:..."
}
```

### Read canonical Markdown

```http
GET /api/docs/:docId/branches/:branchId/read
```

Response:

```json
{
  "docId": "doc_abc",
  "branchId": "br_main",
  "versionId": "ver_043",
  "versionNumber": 43,
  "hash": "sha256:7b91a2cf...",
  "markdown": "# Strategy memo\n\n..."
}
```

### Full write

```http
POST /api/docs/:docId/branches/:branchId/write
```

Request:

```json
{
  "baseVersionId": "ver_043",
  "baseHash": "sha256:7b91a2cf...",
  "markdown": "# Revised memo\n\n..."
}
```

Response when accepted:

```json
{
  "versionId": "ver_044",
  "versionNumber": 44,
  "hash": "sha256:2c13d9aa..."
}
```

Response when live state changed after the agent read its base:

```json
{
  "error": "live_yjs_state_changed"
}
```

HTTP status: `409`.

`write_doc` must validate both `baseVersionId` and `baseHash`. If the version id is stale even with a matching hash, return:

```json
{
  "error": "stale_base_version",
  "currentVersionId": "ver_045",
  "currentHash": "sha256:..."
}
```

> **Context note:** Earlier route sketches parsed `baseVersionId` but only checked `baseHash`. The corrected contract treats the version id as part of the full-write guard so agents receive precise conflict information.

If the branch head is still the requested base version but freshly serialized live Yjs has moved past the submitted `baseHash`, return `409 live_yjs_state_changed`. This is the retry signal for agents: call `read_doc` again, merge the latest human/live edits into the intended target, and retry with the new base.

An accepted `write_doc` is full-document at the API boundary only. Internally it must run through the minimal transaction live writer: parse the target canonical Markdown, compare it to the current Yjs-bound ProseMirror document, apply only changed ranges through transactions/Yjs updates, serialize the live document back to canonical Markdown, and then update `yjs_state`, `current_markdown`, `current_hash`, and the branch head version in one transaction.

### Local edit

```http
POST /api/docs/:docId/branches/:branchId/edit
```

Request:

```json
{
  "observedVersionId": "ver_043",
  "oldString": "Old paragraph.",
  "newString": "New paragraph.",
  "replaceAll": false
}
```

Accepted response:

```json
{
  "versionId": "ver_044",
  "versionNumber": 44,
  "hash": "sha256:..."
}
```

Conflict responses:

```json
{
  "error": "old_string_not_found"
}
```

```json
{
  "error": "ambiguous_match",
  "matchCount": 3
}
```

HTTP status: `409`.

`edit_doc` does not weaken conflict detection by relying on positions, cursor state, or stale client selections. It computes target Markdown by applying exact `oldString`/`newString` matching against the current canonical Markdown and then sends that target through the same minimal transaction live writer as `write_doc`.

If the agent needs to change multiple independent regions as one coherent proposal, it should use `write_doc` with the full target Markdown. The backend's minimal transaction live writer still applies only changed ranges to Milkdown/Yjs state, so `write_doc` does not imply a wholesale live-document replacement.

## Agent review artifacts

No in-app diff UI, server-side preview object, change-set persistence, or default local proposal snapshot workflow is part of MVP. Agents may use their own chat explanations, native tool permission UI, and optional local files to reason about proposed changes, but MarkLab's product protocol is only:

```text
read_doc -> edit_doc for one exact local replacement
read_doc -> write_doc for full target Markdown
```

The server reports deterministic execution outcomes such as `written`, `stale_base_version`, `live_yjs_state_changed`, `old_string_not_found`, and `ambiguous_match`. User-level accept/reject is owned by Codex/Claude Code or the surrounding agent runtime, not by MarkLab API state.

### Export

```http
GET /api/docs/:docId/branches/:branchId/export.md
```

Response:

- Content-Type: `text/markdown; charset=utf-8`
- Content-Disposition filename uses export metadata format.

Before export, the branch is flushed through the same Milkdown serializer path used by `read_doc`. The response filename must use a version/hash that match the exported body; if the post-flush mirror and branch head version still disagree, return `409 export_version_mismatch` instead of producing a misleading versioned filename.

### Branch from version

```http
POST /api/docs/:docId/versions/:versionId/branch
```

Request:

```json
{
  "name": "Branch from v12"
}
```

### Restore version as new head

```http
POST /api/docs/:docId/branches/:branchId/restore
```

Request:

```json
{
  "versionId": "ver_012"
}
```

Response:

```json
{
  "versionId": "ver_044",
  "versionNumber": 44,
  "hash": "sha256:..."
}
```

Restore creates a new version with operation `rollback`, initializes live Yjs state from the selected version Markdown through the Milkdown transformer, updates the branch head, and leaves all previous versions intact.

Response:

```json
{
  "branchId": "br_v12_branch",
  "headVersionId": "ver_new_001"
}
```

### Version list

```http
GET /api/docs/:docId/branches/:branchId/versions
```

Response:

```json
{
  "versions": [
    {
      "versionId": "ver_043",
      "versionNumber": 43,
      "parentVersionId": "ver_042",
      "hash": "sha256:...",
      "actorType": "agent",
      "operation": "write",
      "createdAt": "2026-04-29T15:30:12.000Z"
    }
  ]
}
```

### Version show

```http
GET /api/docs/:docId/versions/:versionId
```

Response:

```json
{
  "versionId": "ver_043",
  "branchId": "br_main",
  "versionNumber": 43,
  "parentVersionId": "ver_042",
  "hash": "sha256:...",
  "actorType": "agent",
  "operation": "write",
  "markdown": "# Strategy memo\n\n...",
  "createdAt": "2026-04-29T15:30:12.000Z"
}
```

### Agent tokens

```http
POST /api/docs/:docId/branches/:branchId/agent-tokens
GET /api/docs/:docId/branches/:branchId/agent-tokens
DELETE /api/agent-tokens/:tokenId
```

Create request:

```json
{
  "name": "Codex",
  "canWrite": true,
  "expiresAt": null
}
```

Create response includes the raw token exactly once:

```json
{
  "tokenId": "tok_123",
  "token": "ml_agent_...",
  "name": "Codex",
  "canRead": true,
  "canWrite": true,
  "expiresAt": null
}
```

List responses must not include raw `token`.

### Share links

```http
POST /api/docs/:docId/branches/:branchId/share-links
GET /api/docs/:docId/branches/:branchId/share-links
DELETE /api/share-links/:linkId
```

Create request:

```json
{
  "role": "edit",
  "expiresAt": null
}
```

Create response includes the raw token exactly once:

```json
{
  "linkId": "link_123",
  "token": "ml_share_...",
  "role": "edit",
  "expiresAt": null
}
```

Production mode should require either an `Authorization: Bearer <token>` header or a route/share token for protected REST and WebSocket document access.

Until full user accounts exist, production create/import and access-management routes require an admin/bootstrap token:

```http
Authorization: Bearer <admin-token>
```

The server stores only `MARKLAB_ADMIN_TOKEN_HASH`, not the raw admin token.
