import { describe, expect, it } from 'vitest';
import type { DbQueryResult } from '../db/client';
import { ensureProviderDocId } from './provider-doc-service';

function createProviderDocPool(existingProviderDocId: string | null = null) {
  const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  return {
    calls,
    async query<Row = unknown>(sql: string, params: readonly unknown[] = []): Promise<DbQueryResult<Row>> {
      calls.push({ sql, params });
      if (/select provider_doc_id/u.test(sql)) {
        return { rows: (existingProviderDocId ? [{ provider_doc_id: existingProviderDocId }] : [{ provider_doc_id: null }]) as Row[] };
      }
      if (/update document_branch_states/u.test(sql)) {
        return { rows: [{ provider_doc_id: params[1] }] as Row[] };
      }
      throw new Error(`unexpected_query:${sql}`);
    },
  };
}

describe('ensureProviderDocId', () => {
  it('reuses an existing opaque provider document id', async () => {
    const pool = createProviderDocPool('ml_doc_existing');
    await expect(ensureProviderDocId(pool, 'branch_1')).resolves.toBe('ml_doc_existing');
    expect(pool.calls).toHaveLength(1);
  });

  it('creates an opaque provider document id when the branch state has none', async () => {
    const pool = createProviderDocPool(null);
    const providerDocId = await ensureProviderDocId(pool, 'branch_1');
    expect(providerDocId).toMatch(/^ml_doc_[0-9a-f-]{36}$/u);
    expect(pool.calls).toHaveLength(2);
  });
});
