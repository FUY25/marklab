import { describe, expect, it } from 'vitest';
import type { ClientToken } from '@y-sweet/sdk';
import { PROVIDER_TOKEN_TTL_SECONDS } from '../config/provider-token-policy';
import { createYSweetTokenService, type YSweetDocumentManagerLike } from './ysweet-token-service';

function createFakeManager(): YSweetDocumentManagerLike & {
  calls: Array<{ docId?: string; authorization?: string; validForSeconds?: number }>;
} {
  const calls: Array<{ docId?: string; authorization?: string; validForSeconds?: number }> = [];
  return {
    calls,
    async getOrCreateDocAndToken(docId, request) {
      const call: { docId?: string; authorization?: string; validForSeconds?: number } = {};
      if (docId !== undefined) call.docId = docId;
      if (request?.authorization !== undefined) call.authorization = request.authorization;
      if (request?.validForSeconds !== undefined) call.validForSeconds = request.validForSeconds;
      calls.push(call);
      const clientToken: ClientToken = {
        url: 'ws://ysweet.example.test',
        baseUrl: 'http://ysweet.example.test/doc/ml_doc_1',
        docId: docId ?? 'ml_doc_generated',
        token: 'ysweet_token',
      };
      if (request?.authorization !== undefined) clientToken.authorization = request.authorization;
      return clientToken;
    },
  };
}

describe('createYSweetTokenService', () => {
  it('issues full edit tokens with the configured default ttl', async () => {
    const manager = createFakeManager();
    const service = createYSweetTokenService({ manager });

    const issued = await service.issueProviderToken({
      providerDocId: 'ml_doc_1',
      sessionId: 'session_1',
      authorization: 'full',
    });

    expect(manager.calls).toEqual([{ docId: 'ml_doc_1', authorization: 'full', validForSeconds: PROVIDER_TOKEN_TTL_SECONDS }]);
    expect(issued).toMatchObject({
      providerDocId: 'ml_doc_1',
      sessionId: 'session_1',
      authorization: 'full',
      validForSeconds: PROVIDER_TOKEN_TTL_SECONDS,
      clientToken: {
        docId: 'ml_doc_1',
        token: 'ysweet_token',
      },
    });
  });

  it('passes read-only authorization and explicit ttl through to Y-Sweet', async () => {
    const manager = createFakeManager();
    const service = createYSweetTokenService({ manager, defaultValidForSeconds: PROVIDER_TOKEN_TTL_SECONDS });
    const explicitTtlSeconds = PROVIDER_TOKEN_TTL_SECONDS / 5;

    const issued = await service.issueProviderToken({
      providerDocId: 'ml_doc_2',
      sessionId: 'session_2',
      authorization: 'read-only',
      validForSeconds: explicitTtlSeconds,
    });

    expect(manager.calls).toEqual([{ docId: 'ml_doc_2', authorization: 'read-only', validForSeconds: explicitTtlSeconds }]);
    expect(issued.authorization).toBe('read-only');
    expect(issued.validForSeconds).toBe(explicitTtlSeconds);
  });
});
