import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

async function schemaSql(): Promise<string> {
  return await readFile(resolve('apps/api/src/db/schema.sql'), 'utf8');
}

function compact(sql: string): string {
  return sql.replace(/\s+/gu, ' ').trim();
}

describe('control-plane schema contract', () => {
  it('defines login, workspace, folder, plan, seat, and subscription tables', async () => {
    const schema = await schemaSql();

	    for (const table of [
	      'users',
	      'user_sessions',
      'oidc_login_states',
	      'workspaces',
      'workspace_members',
      'workspace_share_keys',
      'workspace_folders',
      'folder_access_policies',
      'plans',
      'seat_limits',
      'subscriptions',
    ]) {
      expect(schema).toContain(`create table if not exists ${table}`);
    }
    expect(schema).toContain("role text not null check (role in ('Owner', 'Member', 'Reader'))");
    expect(schema).toContain('token_hash text not null unique');
    expect(schema).toContain('state_hash text not null unique');
    expect(schema).toContain('code_verifier text not null');
    expect(schema).toContain('create index if not exists oidc_login_states_expiration_idx');
    const workspaceShareKeysDefinition = schema.match(/create table if not exists workspace_share_keys \([\s\S]*?\n\);/u)?.[0] ?? '';
    expect(workspaceShareKeysDefinition).toContain("role text not null check (role in ('Member', 'Reader'))");
    expect(workspaceShareKeysDefinition).not.toContain("'Owner'");
    expect(schema).toContain("insert into plans (id, name)");
    expect(schema).toContain("('free', 'Free')");
    expect(schema).toContain("('dev', 'Dev')");
    expect(schema).toContain('concurrent_guest_edits integer not null');
    expect(schema).toContain("('dev', 1000, 1000)");
    expect(schema).toContain("status text not null default 'active' check (status in ('active', 'failed', 'closed'))");
    expect(schema).toContain("add column if not exists status text not null default 'active'");
    expect(compact(schema)).toContain('create unique index if not exists workspace_folders_root_name_idx on workspace_folders (workspace_id, name) where parent_folder_id is null');
  });

  it('renames generic access tables without parallel-creating a second grant system', async () => {
    const normalized = compact(await schemaSql());

    expect(normalized).toContain('alter table access_grants rename to document_access_grants');
    expect(normalized).toContain('alter table access_sessions rename to document_access_sessions');
    expect(normalized).not.toContain('create table if not exists access_grants');
    expect(normalized).not.toContain('create table if not exists access_sessions');
    expect(normalized).toContain('create table if not exists document_access_grants');
    expect(normalized).toContain('create table if not exists document_access_sessions');
  });

  it('extends document access and documents for workspace/folder ownership while keeping workspace nullable', async () => {
    const schema = await schemaSql();
    const normalized = compact(schema);

    expect(normalized).toContain('alter table document_access_grants add column if not exists workspace_id uuid');
    expect(normalized).toContain('add column if not exists folder_id uuid');
    expect(normalized).toContain('add column if not exists created_by_user_id uuid');
    expect(normalized).toContain('alter table document_access_grants alter column branch_id drop not null');
    expect(normalized).toContain("grant_kind text not null default 'access' check (grant_kind in ('access', 'share'))");
    expect(normalized).toContain("constraint document_access_grants_kind_check check (grant_kind in ('access', 'share'))");
    expect(normalized).toContain('add column if not exists actor_kind text');
    expect(normalized).toContain('alter table document_access_sessions alter column grant_id drop not null');
    expect(normalized).toContain('add column if not exists doc_id uuid');
    expect(normalized).toContain('add column if not exists branch_id uuid');
    expect(normalized).toContain('constraint document_access_sessions_doc_fk foreign key (doc_id) references documents(id) on delete cascade not valid');
    expect(normalized).toContain('constraint document_access_sessions_branch_fk foreign key (branch_id) references document_branches(id) on delete set null not valid');
    expect(normalized).toContain('create index if not exists document_access_sessions_doc_seen_idx');
    expect(normalized).toContain('drop constraint if exists access_sessions_client_kind_check');
    expect(normalized).toContain("constraint document_access_sessions_client_kind_check check (client_kind in ('browser', 'app', 'daemon', 'agent', 'api'))");
    expect(normalized).toContain("actor_kind text check (actor_kind in ('user', 'guest', 'agent', 'daemon'))");
    expect(normalized).toContain("update document_access_sessions set actor_kind = 'guest' where actor_kind is null");
    expect(normalized).toContain("alter table document_access_sessions alter column actor_kind set default 'guest'");
    expect(normalized).toContain('alter column actor_kind set not null');
    expect(normalized).toContain('alter table documents add column if not exists workspace_id uuid');
    expect(normalized).toContain('alter table documents add column if not exists folder_id uuid');
    expect(normalized).toContain('constraint documents_workspace_fk foreign key (workspace_id) references workspaces(id) on delete set null not valid');
    expect(normalized).toContain('constraint documents_folder_fk foreign key (folder_id) references workspace_folders(id) on delete set null not valid');
    const documentsDefinition = schema.match(/create table if not exists documents \([\s\S]*?\n\);/u)?.[0] ?? '';
    expect(documentsDefinition).not.toMatch(/workspace_id uuid not null/u);
    expect(normalized).not.toContain('alter table documents add column if not exists workspace_id uuid not null');
  });

  it('marks legacy share and relay tables read-only in schema comments', async () => {
    const schema = await schemaSql();
    const normalized = compact(schema);

    expect(schema).toContain('-- legacy, do not write: share_links');
    expect(normalized).toContain('insert into document_access_grants');
    expect(normalized).toContain('from share_links');
    expect(normalized).toContain("(doc_id, branch_id, grant_kind, token_hash, role, expires_at, revoked_at, created_at) select s.doc_id, s.branch_id, 'share'");
    expect(normalized).toContain('on conflict (token_hash) do nothing');
    expect(schema).toContain('-- legacy: host-gated alpha, do not write: relay_rooms');
    expect(schema).toContain('-- legacy: host-gated alpha, do not write: relay_access_grants');
    expect(schema).toContain('-- legacy: host-gated alpha, do not write: relay_access_sessions');
  });

  it('keeps provider token issuances tied to collab edit sessions and records refresh attempts', async () => {
    const schema = await schemaSql();
    const normalized = compact(schema);
    const collabSessionsDefinition = schema.match(/create table if not exists collab_sessions \([\s\S]*?\n\);/u)?.[0] ?? '';

    expect(normalized).toContain('create table if not exists provider_token_refreshes');
    expect(collabSessionsDefinition).toContain('expires_at timestamptz');
    expect(normalized).toContain('alter table collab_sessions');
    expect(normalized).toContain('add column if not exists expires_at timestamptz');
    expect(normalized).toContain('update collab_sessions s set expires_at = latest.expires_at');
    expect(normalized).toContain('from provider_token_issuances where "authorization" = \'full\' and status = \'issued\'');
    expect(normalized).toContain("where s.id = latest.session_id and s.doc_id = latest.doc_id and s.branch_id = latest.branch_id and s.expires_at is null and s.mode = 'edit' and s.status = 'active'");
    expect(normalized).toContain('alter table provider_token_issuances add column if not exists actor_type text');
    expect(normalized).toContain('add column if not exists workspace_id uuid');
    expect(normalized).toContain('add column if not exists folder_id uuid');
    expect(normalized).toContain('foreign key (session_id) references collab_sessions(id)');
    expect(normalized).not.toContain('constraint provider_token_issuances_session_fk foreign key (session_id) references collab_sessions(id) on delete cascade');
    expect(normalized).toContain('constraint provider_token_refreshes_session_id_fkey foreign key (session_id) references collab_sessions(id) on delete restrict not valid');
    expect(normalized).not.toContain('session_id text not null references collab_sessions(id) on delete cascade');
    expect(normalized).toContain('constraint provider_token_issuances_session_fk');
    expect(normalized).not.toContain('references document_access_sessions(id)');
  });
});
