import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { DbPool, DbQueryResult, DbTransactionClient } from '../db/client';
import { createHttpApp, type HttpRequestAuth } from '../http/app';
import { PROVIDER_TOKEN_TTL_SECONDS } from '../config/provider-token-policy';
import type { ProviderTokenService } from '../provider/ysweet-token-service';
import { createUnavailableLiveMarkdownWriter } from '../services/live-writer';

function createPool(): DbPool {
  const query: DbPool['query'] = async <Row = unknown>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<DbQueryResult<Row>> => {
    if (/select provider_doc_id/u.test(sql)) return { rows: [{ provider_doc_id: 'ml_doc_existing' } as Row] };
    if (/insert into provider_token_issuances/u.test(sql)) return { rows: [], rowCount: 1 };
    if (/from documents d/u.test(sql)) {
      return {
        rows: [{
          doc_id: params?.[0],
          branch_id: params?.[1],
          version_id: 'version_1',
          version_number: 1,
          current_hash: 'sha256:markdown',
          current_markdown: '# Visible\n',
        } as Row],
        rowCount: 1,
      };
    }
    throw new Error(`unexpected_query:${sql}`);
  };

  return {
    query,
    async connect(): Promise<DbTransactionClient> {
      throw new Error('not_used');
    },
  };
}

function createAuth(input: { denyWrite?: boolean } = {}): HttpRequestAuth & { operations: string[] } {
  const operations: string[] = [];
  return {
    operations,
    async requireAdminAccess() {},
    async requireDocumentAccess(_req, _docId, _branchId, operation) {
      operations.push(operation);
      if (operation === 'write' && input.denyWrite) throw new Error('forbidden');
      return { actorType: 'user' };
    },
  };
}

function createProviderTokenService(): ProviderTokenService & { issued: unknown[] } {
  const issued: unknown[] = [];
  return {
    issued,
    async issueProviderToken(input) {
      issued.push(input);
      return {
        providerDocId: input.providerDocId,
        sessionId: input.sessionId,
        authorization: input.authorization,
        validForSeconds: input.validForSeconds ?? PROVIDER_TOKEN_TTL_SECONDS,
        issuedAt: '2026-05-11T00:00:00.000Z',
        expiresAt: '2026-05-11T00:10:00.000Z',
        clientToken: {
          url: 'ws://ysweet.example.test',
          baseUrl: 'http://ysweet.example.test/doc/ml_doc_existing',
          docId: input.providerDocId,
          token: 'ysweet_token',
          authorization: input.authorization,
        },
      };
    },
  };
}

describe('collab session routes', () => {
  it('issues an edit provider token only after write access succeeds', async () => {
    const auth = createAuth();
    const providerTokenService = createProviderTokenService();
    const app = createHttpApp(createPool(), createUnavailableLiveMarkdownWriter(), { auth, providerTokenService });

    const response = await request(app)
      .post('/api/docs/doc_1/branches/branch_1/collab/session')
      .send({ mode: 'edit', clientKind: 'browser', displayName: 'Alice' })
      .expect(201);

    expect(auth.operations).toEqual(['write']);
    expect(providerTokenService.issued).toEqual([expect.objectContaining({
      providerDocId: 'ml_doc_existing',
      authorization: 'full',
      validForSeconds: PROVIDER_TOKEN_TTL_SECONDS,
    })]);
    expect(response.body.providerToken.clientToken.token).toBe('ysweet_token');
    expect(response.body.providerToken.clientToken.authorization).toBe('full');
  });

  it('returns a public view snapshot without provider credentials', async () => {
    const auth = createAuth();
    const providerTokenService = createProviderTokenService();
    const app = createHttpApp(createPool(), createUnavailableLiveMarkdownWriter(), { auth, providerTokenService });

    const response = await request(app)
      .post('/api/docs/doc_1/branches/branch_1/collab/session')
      .send({ mode: 'view', clientKind: 'guest', displayName: 'Guest' })
      .expect(200);

    expect(auth.operations).toEqual(['read']);
    expect(providerTokenService.issued).toEqual([]);
    expect(response.body).toMatchObject({
      mode: 'view',
      document: {
        markdown: '# Visible\n',
        hash: 'sha256:markdown',
      },
    });
    expect(response.body.providerToken).toBeUndefined();
  });

  it('refreshes an edit provider token only after write access succeeds', async () => {
    const auth = createAuth();
    const providerTokenService = createProviderTokenService();
    const app = createHttpApp(createPool(), createUnavailableLiveMarkdownWriter(), { auth, providerTokenService });

    const response = await request(app)
      .post('/api/docs/doc_1/branches/branch_1/collab/session/session_1/provider-token/refresh')
      .send({})
      .expect(200);

    expect(auth.operations).toEqual(['write']);
    expect(providerTokenService.issued).toEqual([{
      providerDocId: 'ml_doc_existing',
      sessionId: 'session_1',
      authorization: 'full',
      validForSeconds: PROVIDER_TOKEN_TTL_SECONDS,
    }]);
    expect(response.body.providerToken.clientToken.authorization).toBe('full');
    expect(response.body.providerToken.validForSeconds).toBe(PROVIDER_TOKEN_TTL_SECONDS);
  });

  it('does not issue a refresh provider token when write access is denied', async () => {
    const auth = createAuth({ denyWrite: true });
    const providerTokenService = createProviderTokenService();
    const app = createHttpApp(createPool(), createUnavailableLiveMarkdownWriter(), { auth, providerTokenService });

    await request(app)
      .post('/api/docs/doc_1/branches/branch_1/collab/session/session_1/provider-token/refresh')
      .send({})
      .expect(403);

    expect(auth.operations).toEqual(['write']);
    expect(providerTokenService.issued).toEqual([]);
  });
});
