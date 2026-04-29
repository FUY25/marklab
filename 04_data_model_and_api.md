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
  baseVersionId: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}

export interface MultiEditDocRequest {
  baseVersionId: string;
  edits: Array<{
    oldString: string;
    newString: string;
    replaceAll?: boolean;
  }>;
}
```

Local agent proposal snapshots are not database records in MVP. They are files produced by the CLI workflow from `read_doc` responses. Their required metadata is `docId`, `branchId`, `baseVersionId`, `baseVersionNumber`, `baseHash`, `createdAt`, `proposalPath`, and `snapshotRole: "proposal"`.

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

Response:

```json
{
  "docId": "doc_abc",
  "branchId": "br_main",
  "versionId": "ver_001"
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

Response when stale:

```json
{
  "error": "stale_base_hash",
  "currentVersionId": "ver_045",
  "currentHash": "sha256:..."
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

An accepted `write_doc` is full-document at the API boundary only. Internally it must run through the minimal transaction live writer: parse the target canonical Markdown, compare it to the current Yjs-bound ProseMirror document, apply only changed ranges through transactions/Yjs updates, serialize the live document back to canonical Markdown, and then update `current_markdown`, `current_hash`, and the branch head version.

### Local edit

```http
POST /api/docs/:docId/branches/:branchId/edit
```

Request:

```json
{
  "baseVersionId": "ver_043",
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

### Atomic multi edit

```http
POST /api/docs/:docId/branches/:branchId/multi-edit
```

Request:

```json
{
  "baseVersionId": "ver_043",
  "edits": [
    {
      "oldString": "Old paragraph A.",
      "newString": "New paragraph A.",
      "replaceAll": false
    },
    {
      "oldString": "Old paragraph B.",
      "newString": "New paragraph B.",
      "replaceAll": false
    }
  ]
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

Conflict responses use the same error codes as `edit_doc`, with an `editIndex` identifying the failed operation:

```json
{
  "error": "old_string_not_found",
  "editIndex": 1
}
```

```json
{
  "error": "ambiguous_match",
  "editIndex": 0,
  "matchCount": 3
}
```

HTTP status: `409`.

`multi_edit_doc` mirrors Claude Code's MultiEdit mental model. It applies exact replacements in order against a local working Markdown string, aborts before live-state mutation if any replacement fails, then sends the final target Markdown through the same minimal transaction live writer. A successful operation creates one immutable version with operation `edit`.

## Agent-side diff artifacts

No in-app diff UI is part of MVP. Agents should create local proposal snapshots so Codex/Claude Code can use native file-edit review. Product exports remain user artifacts and should not be confused with agent proposal snapshots.

Expected local snapshot layout:

```text
.marklab/snapshots/{slug}__SNAPSHOT__doc-{docIdShort}__branch-{branchIdOrSlug}__v{versionNumber}__ver-{versionId}__{yyyyMMdd-HHmmssZ}__sha-{hash8}/
  proposal.md
  metadata.json
```

`metadata.json` includes:

```json
{
  "docId": "doc_abc",
  "branchId": "br_main",
  "baseVersionId": "ver_043",
  "baseVersionNumber": 43,
  "baseHash": "sha256:7b91a2cf...",
  "createdAt": "2026-04-29T15:30:12Z",
  "proposalPath": "proposal.md",
  "snapshotRole": "proposal"
}
```

No `baseline.md`, `before.md`, or `after.md` is created by default. `proposal.md` starts as the canonical Markdown returned by `read_doc`; the agent environment owns the native local diff and accept/reject UI.

Snapshot files are review artifacts only. They are not authoritative state and must not bypass `write_doc` stale-base checks, `edit_doc` exact string matching, or `multi_edit_doc` ordered exact matching. If the user rejects the native local diff, no MarkLab write/edit command runs.

### Export

```http
GET /api/docs/:docId/branches/:branchId/export.md
```

Response:

- Content-Type: `text/markdown; charset=utf-8`
- Content-Disposition filename uses export metadata format.

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

Response:

```json
{
  "branchId": "br_v12_branch",
  "headVersionId": "ver_new_001"
}
```
