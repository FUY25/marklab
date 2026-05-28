import { readFile } from 'node:fs/promises';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DbPool } from '../db/client';
import { closeDirectUserRuntimeAccess } from './runtime-access-revocation-service';

const databaseUrl = process.env.DATABASE_URL;

describe.runIf(databaseUrl)('closeDirectUserRuntimeAccess with real Postgres', () => {
  const client = new Client({ connectionString: databaseUrl });
  const userId = '00000000-0000-4000-8000-000000000101';
  const workspaceId = '00000000-0000-4000-8000-000000000102';
  const docId = '00000000-0000-4000-8000-000000000103';
  const branchId = '00000000-0000-4000-8000-000000000104';
  const issuanceId = '00000000-0000-4000-8000-000000000105';

  beforeAll(async () => {
    await client.connect();
    await client.query(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
  });

  afterAll(async () => {
    await cleanup();
    await client.end();
  });

  async function cleanup() {
    await client.query('delete from provider_token_issuances where id = $1', [issuanceId]);
    await client.query('delete from collab_sessions where id = $1', ['session_real_revoke']);
    await client.query('delete from document_branch_states where branch_id = $1', [branchId]);
    await client.query('delete from document_branches where id = $1', [branchId]);
    await client.query('delete from documents where id = $1', [docId]);
    await client.query('delete from workspaces where id = $1', [workspaceId]);
    await client.query('delete from users where id = $1', [userId]);
  }

  it('closes direct-user runtime sessions and revokes active provider issuances', async () => {
    await cleanup();
    await client.query(
      `insert into users (id, email, display_name, auth_provider, auth_subject)
       values ($1, 'real-revoke@example.test', 'Real Revoke', 'test', 'real-revoke')`,
      [userId],
    );
    await client.query(
      `insert into workspaces (id, name, owner_user_id)
       values ($1, 'Real Revoke Workspace', $2)`,
      [workspaceId, userId],
    );
    await client.query(
      `insert into workspace_members (workspace_id, user_id, role)
       values ($1, $2, 'Owner')`,
      [workspaceId, userId],
    );
    await client.query(
      `insert into documents (id, owner_id, title, workspace_id)
       values ($1, $2, 'Real revoke doc', $3)`,
      [docId, userId, workspaceId],
    );
    await client.query(
      `insert into document_branches (id, doc_id, name, slug)
       values ($1, $2, 'main', 'main')`,
      [branchId, docId],
    );
    await client.query('update documents set default_branch_id = $2 where id = $1', [docId, branchId]);
    await client.query(
      `insert into document_branch_states
         (branch_id, yjs_state, current_markdown, current_hash, provider_doc_id, provider_doc_seeded_at, provider_doc_contents_ensured_at)
       values ($1, $2, '# Real\n', 'sha256:real', 'provider_real_revoke', now(), now())`,
      [branchId, Buffer.from([1, 2, 3])],
    );
    await client.query(
      `insert into collab_sessions
         (id, doc_id, branch_id, mode, client_kind, actor_type, actor_id, actor_grant_id, refresh_token_hash, is_guest, role, status, display_name, expires_at)
       values
         ('session_real_revoke', $1, $2, 'edit', 'app', 'user', $3, null, 'sha256:refresh', false, 'edit', 'active', 'Real Revoke', now() + interval '10 minutes')`,
      [docId, branchId, userId],
    );
    await client.query(
      `insert into provider_token_issuances
         (id, doc_id, branch_id, workspace_id, provider_doc_id, session_id, client_kind, actor_type, actor_id, actor_grant_id, "authorization", valid_for_seconds, status)
       values
         ($1, $2, $3, $4, 'provider_real_revoke', 'session_real_revoke', 'app', 'user', $5, null, 'full', 600, 'issued')`,
      [issuanceId, docId, branchId, workspaceId, userId],
    );

    const closedRooms: string[] = [];
    const closedProviderDocs: string[][] = [];
    await closeDirectUserRuntimeAccess(client as unknown as DbPool, {
      closeCollabDocumentConnections(roomName) {
        closedRooms.push(roomName);
      },
      closeProviderDocConnections(providerDocIds) {
        closedProviderDocs.push([...providerDocIds]);
      },
    }, {
      userId,
      workspaceId,
      providerError: 'real_postgres_revoke_test',
    });

    const session = await client.query<{ status: string }>(
      `select status from collab_sessions where id = 'session_real_revoke'`,
    );
    const issuance = await client.query<{ status: string; provider_error: string | null }>(
      'select status, provider_error from provider_token_issuances where id = $1',
      [issuanceId],
    );
    expect(session.rows[0]).toEqual({ status: 'closed' });
    expect(issuance.rows[0]).toEqual({ status: 'revoked', provider_error: 'real_postgres_revoke_test' });
    expect(closedRooms).toEqual([`doc:${docId}:branch:${branchId}`]);
    expect(closedProviderDocs).toEqual([['provider_real_revoke']]);
  });
});
