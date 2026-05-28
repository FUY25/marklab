import {
  PROVIDER_TOKEN_TTL_SECONDS,
} from '@marklab/shared/src/provider-token-policy';
import type { ActiveEditSession, IssuedProviderToken } from './collab-session';

export function providerTokenWireFixture(input: Partial<IssuedProviderToken> = {}): IssuedProviderToken {
  const providerDocId = input.providerDocId ?? 'ml_doc_1';
  const sessionId = input.sessionId ?? 'session_1';
  return {
    providerDocId,
    sessionId,
    authorization: 'full',
    validForSeconds: PROVIDER_TOKEN_TTL_SECONDS,
    issuedAt: '2026-05-15T12:00:00.000Z',
    expiresAt: '2026-05-15T12:10:00.000Z',
    clientToken: {
      docId: providerDocId,
      url: `ws://api.example.test/d/${providerDocId}/ws/${providerDocId}`,
      baseUrl: `https://api.example.test/d/${providerDocId}`,
      token: 'ysweet_token',
      authorization: 'full',
    },
    ...input,
  };
}

export function activeEditSessionWireFixture(input: Partial<ActiveEditSession> = {}): ActiveEditSession {
  const providerToken = input.providerToken ?? providerTokenWireFixture({
    providerDocId: 'provider_doc_1',
    sessionId: input.sessionId ?? 'session_1',
    clientToken: {
      docId: 'provider_doc_1',
      url: 'wss://provider.example/d/provider_doc_1/ws/provider_doc_1',
      baseUrl: 'https://provider.example/d/provider_doc_1',
      token: 'raw_ysweet_client_token',
      authorization: 'full',
    },
    issuedAt: '2026-05-11T00:00:00.000Z',
    expiresAt: '2026-05-11T00:10:00.000Z',
  });
  return {
    docId: 'doc_1',
    branchId: 'branch_1',
    sessionId: providerToken.sessionId,
    refreshToken: 'refresh_secret',
    providerToken,
    ...input,
  };
}
