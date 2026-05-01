create extension if not exists pgcrypto;

create table if not exists documents (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  title text not null default 'Untitled',
  default_branch_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists document_branches (
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

alter table documents
  add constraint documents_default_branch_fk
  foreign key (default_branch_id)
  references document_branches(id)
  deferrable initially deferred;

create table if not exists document_branch_states (
  branch_id uuid primary key references document_branches(id) on delete cascade,
  yjs_state bytea not null,
  current_markdown text not null,
  current_hash text not null,
  updated_at timestamptz not null default now()
);

alter table document_branch_states
  add column if not exists yjs_state_fingerprint text;

create table if not exists document_versions (
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

alter table document_branches
  add constraint document_branches_head_version_fk
  foreign key (head_version_id)
  references document_versions(id)
  deferrable initially deferred;

alter table document_branches
  add constraint document_branches_created_from_version_fk
  foreign key (created_from_version_id)
  references document_versions(id)
  deferrable initially deferred;

create index if not exists document_versions_branch_created_idx
  on document_versions (branch_id, created_at desc);

create table if not exists agent_tokens (
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

create table if not exists share_links (
  id uuid primary key default gen_random_uuid(),
  doc_id uuid not null references documents(id) on delete cascade,
  branch_id uuid references document_branches(id) on delete cascade,
  token_hash text not null,
  role text not null check (role in ('view', 'edit')),
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists access_grants (
  id uuid primary key default gen_random_uuid(),
  doc_id uuid not null references documents(id) on delete cascade,
  branch_id uuid not null references document_branches(id) on delete cascade,
  token_hash text not null unique,
  role text not null check (role in ('view', 'edit')),
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists access_sessions (
  id uuid primary key default gen_random_uuid(),
  grant_id uuid not null references access_grants(id) on delete cascade,
  client_id text not null,
  client_kind text not null default 'browser' check (client_kind in ('browser', 'agent', 'api')),
  display_name text not null,
  color text not null,
  last_branch_id uuid references document_branches(id) on delete set null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (grant_id, client_id)
);

create index if not exists access_grants_doc_active_idx
  on access_grants (doc_id, branch_id, created_at desc)
  where revoked_at is null;

create index if not exists access_sessions_grant_seen_idx
  on access_sessions (grant_id, last_seen_at desc);

create table if not exists relay_rooms (
  id uuid primary key default gen_random_uuid(),
  host_session_id text,
  host_auth_token_hash text,
  state text not null default 'host_offline' check (state in ('starting', 'host_online', 'host_offline', 'ended')),
  last_ephemeral_yjs_state bytea,
  last_shared_hash text,
  shared_revision integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists relay_access_grants (
  id uuid primary key default gen_random_uuid(),
  relay_room_id uuid not null references relay_rooms(id) on delete cascade,
  token_hash text not null unique,
  role text not null check (role in ('view', 'edit')),
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists relay_access_sessions (
  id uuid primary key default gen_random_uuid(),
  grant_id uuid references relay_access_grants(id) on delete cascade,
  client_id text not null,
  client_kind text not null default 'browser' check (client_kind in ('browser', 'daemon', 'agent')),
  display_name text not null,
  color text not null,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists relay_access_grants_room_active_idx
  on relay_access_grants (relay_room_id, created_at desc)
  where revoked_at is null;

create index if not exists relay_access_sessions_grant_seen_idx
  on relay_access_sessions (grant_id, last_seen_at desc);

create unique index if not exists relay_access_sessions_grant_client_idx
  on relay_access_sessions (grant_id, client_id)
  where grant_id is not null;
