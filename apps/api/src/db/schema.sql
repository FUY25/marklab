create extension if not exists pgcrypto;

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  display_name text not null default '',
  auth_provider text,
  auth_subject text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (auth_provider, auth_subject)
);

create table if not exists user_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index if not exists user_sessions_user_seen_idx
  on user_sessions (user_id, last_seen_at desc);

create table if not exists oidc_login_states (
  id uuid primary key default gen_random_uuid(),
  state_hash text not null unique,
  code_verifier text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists oidc_login_states_expiration_idx
  on oidc_login_states (expires_at)
  where used_at is null;

create table if not exists workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_user_id uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists workspace_members (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null check (role in ('Owner', 'Member', 'Reader')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table if not exists workspace_share_keys (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  token_hash text not null unique,
  role text not null check (role in ('Member', 'Reader')),
  created_by_user_id uuid references users(id) on delete set null,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

alter table workspace_share_keys
  drop constraint if exists workspace_share_keys_role_check;

alter table workspace_share_keys
  add constraint workspace_share_keys_role_check
  check (role in ('Member', 'Reader')) not valid;

create table if not exists workspace_folders (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  parent_folder_id uuid references workspace_folders(id) on delete cascade,
  name text not null,
  created_by_user_id uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, parent_folder_id, name)
);

create unique index if not exists workspace_folders_root_name_idx
  on workspace_folders (workspace_id, name)
  where parent_folder_id is null;

create table if not exists folder_access_policies (
  id uuid primary key default gen_random_uuid(),
  folder_id uuid not null references workspace_folders(id) on delete cascade,
  role text not null check (role in ('Owner', 'Member', 'Reader')),
  can_read boolean not null default true,
  can_write boolean not null default false,
  created_at timestamptz not null default now(),
  unique (folder_id, role)
);

create table if not exists plans (
  id text primary key,
  name text not null,
  created_at timestamptz not null default now()
);

insert into plans (id, name)
values
  ('free', 'Free'),
  ('dev', 'Dev'),
  ('team', 'Team'),
  ('business', 'Business'),
  ('internal', 'Internal')
on conflict (id) do update set name = excluded.name;

create table if not exists seat_limits (
  plan_id text primary key references plans(id) on delete cascade,
  member_seats integer not null,
  concurrent_guest_edits integer not null,
  updated_at timestamptz not null default now()
);

insert into seat_limits (plan_id, member_seats, concurrent_guest_edits)
values
  ('free', 1, 3),
  ('dev', 1000, 1000),
  ('team', 10, 10),
  ('business', 50, 25),
  ('internal', 1000, 1000)
on conflict (plan_id) do update
  set member_seats = excluded.member_seats,
      concurrent_guest_edits = excluded.concurrent_guest_edits,
      updated_at = now();

create table if not exists subscriptions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  plan_id text not null references plans(id),
  status text not null check (status in ('manual', 'trialing', 'active', 'past_due', 'canceled')),
  billing_mode text not null default 'manual' check (billing_mode in ('manual', 'stripe')),
  external_customer_id text,
  external_subscription_id text,
  billing_metadata jsonb not null default '{}'::jsonb,
  current_period_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id)
);

alter table subscriptions
  add column if not exists billing_mode text not null default 'manual',
  add column if not exists external_customer_id text,
  add column if not exists external_subscription_id text,
  add column if not exists billing_metadata jsonb not null default '{}'::jsonb;

alter table subscriptions
  drop constraint if exists subscriptions_billing_mode_check;

alter table subscriptions
  add constraint subscriptions_billing_mode_check
  check (billing_mode in ('manual', 'stripe'));

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

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conname = 'documents_default_branch_fk'
       and conrelid = 'documents'::regclass
       and confrelid = 'document_branches'::regclass
  ) then
    alter table documents
      add constraint documents_default_branch_fk
      foreign key (default_branch_id)
      references document_branches(id)
      deferrable initially deferred;
  end if;
end
$$;

create table if not exists document_branch_states (
  branch_id uuid primary key references document_branches(id) on delete cascade,
  yjs_state bytea not null,
  current_markdown text not null,
  current_hash text not null,
  updated_at timestamptz not null default now()
);

alter table document_branch_states
  add column if not exists yjs_state_fingerprint text;

alter table document_branch_states
  add column if not exists provider_doc_id text;

alter table document_branch_states
  add column if not exists provider_doc_seeded_at timestamptz;

alter table documents
  add column if not exists workspace_id uuid;

alter table documents
  add column if not exists folder_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'documents_workspace_fk'
  ) then
    alter table documents
      add constraint documents_workspace_fk
      foreign key (workspace_id) references workspaces(id)
      on delete set null
      not valid;
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'documents_folder_fk'
  ) then
    alter table documents
      add constraint documents_folder_fk
      foreign key (folder_id) references workspace_folders(id)
      on delete set null
      not valid;
  end if;
end
$$;

create unique index if not exists document_branch_states_provider_doc_id_idx
  on document_branch_states (provider_doc_id)
  where provider_doc_id is not null;

create table if not exists collab_sessions (
  id text primary key,
  doc_id uuid not null references documents(id) on delete cascade,
  branch_id uuid not null references document_branches(id) on delete cascade,
  mode text not null check (mode in ('view', 'edit')),
  client_kind text not null check (client_kind in ('browser', 'app', 'daemon', 'agent', 'guest')),
  actor_type text not null check (actor_type in ('user', 'agent')),
  actor_id text,
  actor_grant_id text,
  refresh_token_hash text,
  is_guest boolean not null default false,
  role text check (role in ('view', 'edit')),
  status text not null default 'active' check (status in ('active', 'failed', 'closed')),
  display_name text not null,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

alter table collab_sessions
  add column if not exists refresh_token_hash text,
  add column if not exists is_guest boolean not null default false,
  add column if not exists status text not null default 'active',
  add column if not exists expires_at timestamptz;

alter table collab_sessions
  drop constraint if exists collab_sessions_status_check;

alter table collab_sessions
  add constraint collab_sessions_status_check
  check (status in ('active', 'failed', 'closed'));

create index if not exists collab_sessions_doc_seen_idx
  on collab_sessions (doc_id, branch_id, last_seen_at desc);

create index if not exists collab_sessions_refresh_token_hash_idx
  on collab_sessions (refresh_token_hash)
  where refresh_token_hash is not null;

create table if not exists provider_token_issuances (
  id uuid primary key default gen_random_uuid(),
  doc_id uuid not null references documents(id) on delete cascade,
  branch_id uuid not null references document_branches(id) on delete cascade,
  workspace_id uuid,
  folder_id uuid,
  provider_doc_id text not null,
  session_id text not null,
  client_kind text not null check (client_kind in ('browser', 'app', 'daemon', 'agent', 'guest')),
  actor_type text not null default 'user' check (actor_type in ('user', 'agent')),
  actor_id text,
  actor_grant_id text,
  "authorization" text not null check ("authorization" in ('full', 'read-only')),
  valid_for_seconds integer not null,
  status text not null default 'issued' check (status in ('pending', 'issued', 'failed', 'revoked')),
  provider_error text,
  issued_at timestamptz not null default now()
);

alter table provider_token_issuances
  add column if not exists actor_type text not null default 'user',
  add column if not exists actor_id text,
  add column if not exists actor_grant_id text,
  add column if not exists workspace_id uuid,
  add column if not exists folder_id uuid,
  add column if not exists status text not null default 'issued',
  add column if not exists provider_error text;

alter table provider_token_issuances
  alter column actor_grant_id type text using actor_grant_id::text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'provider_token_issuances_client_kind_check'
  ) then
    alter table provider_token_issuances
      add constraint provider_token_issuances_client_kind_check
      check (client_kind in ('browser', 'app', 'daemon', 'agent', 'guest'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'provider_token_issuances_actor_type_check'
  ) then
    alter table provider_token_issuances
      add constraint provider_token_issuances_actor_type_check
      check (actor_type in ('user', 'agent'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'provider_token_issuances_authorization_check'
  ) then
    alter table provider_token_issuances
      add constraint provider_token_issuances_authorization_check
      check ("authorization" in ('full', 'read-only'));
  end if;

end
$$;

alter table provider_token_issuances
  drop constraint if exists provider_token_issuances_status_check;

alter table provider_token_issuances
  add constraint provider_token_issuances_status_check
  check (status in ('pending', 'issued', 'failed', 'revoked'));

update collab_sessions s
   set expires_at = latest.expires_at
  from (
    select distinct on (doc_id, branch_id, session_id)
           doc_id,
           branch_id,
           session_id,
           issued_at + (valid_for_seconds * interval '1 second') as expires_at
      from provider_token_issuances
     where "authorization" = 'full'
       and status = 'issued'
     order by doc_id, branch_id, session_id, issued_at desc, id desc
  ) latest
 where s.id = latest.session_id
   and s.doc_id = latest.doc_id
   and s.branch_id = latest.branch_id
   and s.expires_at is null
   and s.mode = 'edit'
   and s.status = 'active';

do $$
begin
  if exists (
    select 1 from pg_constraint
     where conname = 'provider_token_issuances_session_fk'
       and confdeltype = 'c'
  ) then
    alter table provider_token_issuances
      drop constraint provider_token_issuances_session_fk;
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'provider_token_issuances_session_fk'
  ) then
    alter table provider_token_issuances
      add constraint provider_token_issuances_session_fk
      foreign key (session_id) references collab_sessions(id)
      not valid;
  end if;
end
$$;

create index if not exists provider_token_issuances_branch_issued_idx
  on provider_token_issuances (branch_id, issued_at desc);

create table if not exists provider_token_refreshes (
  id uuid primary key default gen_random_uuid(),
  session_id text not null references collab_sessions(id) on delete restrict,
  issuance_id uuid references provider_token_issuances(id) on delete set null,
  issued_at timestamptz,
  expires_at timestamptz,
  denied_at timestamptz,
  deny_reason text,
  created_at timestamptz not null default now()
);

create index if not exists provider_token_refreshes_session_created_idx
  on provider_token_refreshes (session_id, created_at desc);

do $$
begin
  if exists (
    select 1 from pg_constraint
     where conname = 'provider_token_refreshes_session_id_fkey'
       and confdeltype = 'c'
  ) then
    alter table provider_token_refreshes
      drop constraint provider_token_refreshes_session_id_fkey;
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'provider_token_refreshes_session_id_fkey'
  ) then
    alter table provider_token_refreshes
      add constraint provider_token_refreshes_session_id_fkey
      foreign key (session_id) references collab_sessions(id)
      on delete restrict
      not valid;
  end if;
end
$$;

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

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conname = 'document_branches_head_version_fk'
       and conrelid = 'document_branches'::regclass
       and confrelid = 'document_versions'::regclass
  ) then
    alter table document_branches
      add constraint document_branches_head_version_fk
      foreign key (head_version_id)
      references document_versions(id)
      deferrable initially deferred;
  end if;

  if not exists (
    select 1
      from pg_constraint
     where conname = 'document_branches_created_from_version_fk'
       and conrelid = 'document_branches'::regclass
       and confrelid = 'document_versions'::regclass
  ) then
    alter table document_branches
      add constraint document_branches_created_from_version_fk
      foreign key (created_from_version_id)
      references document_versions(id)
      deferrable initially deferred;
  end if;
end
$$;

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

-- legacy, do not write: share_links
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

do $$
begin
  if to_regclass('public.document_access_grants') is null
     and to_regclass('public.access_grants') is not null then
    execute 'alter table access_grants rename to document_access_grants';
  end if;

  if to_regclass('public.document_access_sessions') is null
     and to_regclass('public.access_sessions') is not null then
    execute 'alter table access_sessions rename to document_access_sessions';
  end if;
end
$$;

create table if not exists document_access_grants (
  id uuid primary key default gen_random_uuid(),
  doc_id uuid not null references documents(id) on delete cascade,
  branch_id uuid references document_branches(id) on delete cascade,
  grant_kind text not null default 'access' check (grant_kind in ('access', 'share')),
  token_hash text not null unique,
  role text not null check (role in ('view', 'edit')),
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

alter table document_access_grants
  add column if not exists workspace_id uuid,
  add column if not exists folder_id uuid,
  add column if not exists created_by_user_id uuid,
  add column if not exists grant_kind text not null default 'access';

alter table document_access_grants
  alter column branch_id drop not null;

alter table document_access_grants
  drop constraint if exists document_access_grants_kind_check;

alter table document_access_grants
  add constraint document_access_grants_kind_check
  check (grant_kind in ('access', 'share'));

insert into document_access_grants
  (doc_id, branch_id, grant_kind, token_hash, role, expires_at, revoked_at, created_at)
select s.doc_id,
       s.branch_id,
       'share',
       s.token_hash,
       s.role,
       s.expires_at,
       s.revoked_at,
       s.created_at
  from share_links s
on conflict (token_hash) do nothing;

create table if not exists document_access_sessions (
  id uuid primary key default gen_random_uuid(),
  grant_id uuid references document_access_grants(id) on delete cascade,
  doc_id uuid references documents(id) on delete cascade,
  branch_id uuid references document_branches(id) on delete set null,
  client_id text not null,
  client_kind text not null default 'browser' check (client_kind in ('browser', 'app', 'daemon', 'agent', 'api')),
  actor_kind text check (actor_kind in ('user', 'guest', 'agent', 'daemon')) not null default 'guest',
  actor_id text,
  display_name text not null,
  color text not null,
  last_branch_id uuid references document_branches(id) on delete set null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (grant_id, client_id)
);

alter table document_access_sessions
  alter column grant_id drop not null,
  add column if not exists doc_id uuid,
  add column if not exists branch_id uuid,
  add column if not exists actor_kind text,
  add column if not exists actor_id text;

update document_access_sessions s
   set doc_id = coalesce(s.doc_id, g.doc_id),
       branch_id = coalesce(s.branch_id, s.last_branch_id, g.branch_id)
  from document_access_grants g
 where s.grant_id = g.id
   and (s.doc_id is null or s.branch_id is null);

update document_access_sessions
   set actor_kind = 'guest'
 where actor_kind is null;

alter table document_access_sessions
  alter column actor_kind set default 'guest',
  alter column actor_kind set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'document_access_sessions_actor_kind_check'
  ) then
    alter table document_access_sessions
      add constraint document_access_sessions_actor_kind_check
      check (actor_kind in ('user', 'guest', 'agent', 'daemon'));
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'document_access_sessions_doc_fk'
  ) then
    alter table document_access_sessions
      add constraint document_access_sessions_doc_fk
      foreign key (doc_id) references documents(id) on delete cascade not valid;
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'document_access_sessions_branch_fk'
  ) then
    alter table document_access_sessions
      add constraint document_access_sessions_branch_fk
      foreign key (branch_id) references document_branches(id) on delete set null not valid;
  end if;
end
$$;

alter table document_access_sessions
  drop constraint if exists access_sessions_client_kind_check,
  drop constraint if exists document_access_sessions_client_kind_check;

alter table document_access_sessions
  add constraint document_access_sessions_client_kind_check
  check (client_kind in ('browser', 'app', 'daemon', 'agent', 'api'));

create index if not exists document_access_grants_doc_active_idx
  on document_access_grants (doc_id, branch_id, created_at desc)
  where revoked_at is null;

create index if not exists document_access_sessions_grant_seen_idx
  on document_access_sessions (grant_id, last_seen_at desc);

create index if not exists document_access_sessions_doc_seen_idx
  on document_access_sessions (doc_id, branch_id, last_seen_at desc);

-- legacy: host-gated alpha, do not write: relay_rooms
create table if not exists relay_rooms (
  id uuid primary key default gen_random_uuid(),
  host_session_id text,
  host_auth_token_hash text,
  state text not null default 'host_offline' check (state in ('starting', 'host_online', 'host_offline', 'ended')),
  last_ephemeral_yjs_state bytea,
  last_shared_hash text,
  shared_revision integer not null default 0,
  accepted_shared_revision integer,
  accepted_shared_hash text,
  ephemeral_cache_expires_at timestamptz,
  ephemeral_last_updated_at timestamptz,
  cleanup_last_run_at timestamptz,
  host_lease_expires_at timestamptz,
  host_offline_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table relay_rooms
  add column if not exists accepted_shared_revision integer,
  add column if not exists accepted_shared_hash text,
  add column if not exists ephemeral_cache_expires_at timestamptz,
  add column if not exists ephemeral_last_updated_at timestamptz,
  add column if not exists cleanup_last_run_at timestamptz,
  add column if not exists host_lease_expires_at timestamptz,
  add column if not exists host_offline_reason text;

-- legacy: host-gated alpha, do not write: relay_access_grants
create table if not exists relay_access_grants (
  id uuid primary key default gen_random_uuid(),
  relay_room_id uuid not null references relay_rooms(id) on delete cascade,
  token_hash text not null unique,
  role text not null check (role in ('view', 'edit')),
  accepted_shared_revision integer,
  accepted_shared_hash text,
  expires_at timestamptz,
  revoked_at timestamptz,
  cleanup_last_run_at timestamptz,
  created_at timestamptz not null default now()
);

alter table relay_access_grants
  add column if not exists accepted_shared_revision integer,
  add column if not exists accepted_shared_hash text,
  add column if not exists cleanup_last_run_at timestamptz;

-- legacy: host-gated alpha, do not write: relay_access_sessions
create table if not exists relay_access_sessions (
  id uuid primary key default gen_random_uuid(),
  grant_id uuid references relay_access_grants(id) on delete cascade,
  client_id text not null,
  client_kind text not null default 'browser' check (client_kind in ('browser', 'daemon', 'agent')),
  display_name text not null,
  color text not null,
  expires_at timestamptz,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

alter table relay_access_sessions
  add column if not exists expires_at timestamptz;

create index if not exists relay_access_grants_room_active_idx
  on relay_access_grants (relay_room_id, created_at desc)
  where revoked_at is null;

create index if not exists relay_access_grants_token_hash_idx
  on relay_access_grants (token_hash);

create index if not exists relay_access_grants_expiration_idx
  on relay_access_grants (expires_at)
  where revoked_at is null and expires_at is not null;

create index if not exists relay_access_sessions_grant_seen_idx
  on relay_access_sessions (grant_id, last_seen_at desc);

create index if not exists relay_access_sessions_expiration_idx
  on relay_access_sessions (expires_at)
  where expires_at is not null;

create index if not exists relay_access_sessions_seen_idx
  on relay_access_sessions (last_seen_at);

create unique index if not exists relay_access_sessions_grant_client_idx
  on relay_access_sessions (grant_id, client_id)
  where grant_id is not null;

create index if not exists relay_rooms_host_lease_expiration_idx
  on relay_rooms (host_lease_expires_at)
  where state = 'host_online' and host_lease_expires_at is not null;

create index if not exists relay_rooms_ephemeral_expiration_idx
  on relay_rooms (ephemeral_cache_expires_at)
  where ephemeral_cache_expires_at is not null;
