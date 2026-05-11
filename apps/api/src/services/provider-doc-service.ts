import { randomUUID } from 'node:crypto';
import type { DbExecutor } from '../db/client';

export async function ensureProviderDocId(pool: DbExecutor, branchId: string): Promise<string> {
  const existing = await pool.query<{ provider_doc_id: string | null }>(
    `select provider_doc_id
       from document_branch_states
      where branch_id = $1`,
    [branchId],
  );

  const providerDocId = existing.rows[0]?.provider_doc_id;
  if (providerDocId) return providerDocId;

  const generated = `ml_doc_${randomUUID()}`;
  const updated = await pool.query<{ provider_doc_id: string }>(
    `update document_branch_states
        set provider_doc_id = coalesce(provider_doc_id, $2),
            updated_at = now()
      where branch_id = $1
      returning provider_doc_id`,
    [branchId, generated],
  );

  const row = updated.rows[0];
  if (!row) throw new Error('branch_not_found');
  return row.provider_doc_id;
}

export async function recordProviderTokenIssuance(pool: DbExecutor, input: {
  docId: string;
  branchId: string;
  providerDocId: string;
  sessionId: string;
  clientKind: 'browser' | 'app' | 'daemon' | 'agent' | 'guest';
  authorization: 'full' | 'read-only';
  validForSeconds: number;
}): Promise<void> {
  await pool.query(
    `insert into provider_token_issuances
       (doc_id, branch_id, provider_doc_id, session_id, client_kind, authorization, valid_for_seconds)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.docId,
      input.branchId,
      input.providerDocId,
      input.sessionId,
      input.clientKind,
      input.authorization,
      input.validForSeconds,
    ],
  );
}
