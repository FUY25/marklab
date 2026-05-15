import { describe, expect, it, vi } from 'vitest';
import {
  CollabSessionError,
  createActiveEditSession,
  createCollabSessionClient,
  isTerminalProviderRefreshError,
  providerTokenRefreshDelayMs,
  providerTokenRefreshRetryDelayMs,
  type IssuedProviderToken,
} from './collab-session';
import {
  PROVIDER_TOKEN_REFRESH_CHECK_INTERVAL_SECONDS,
  PROVIDER_TOKEN_REFRESH_MARGIN_SECONDS,
  PROVIDER_TOKEN_TTL_SECONDS,
} from '@marklab/shared/src/provider-token-policy';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function createProviderToken(input: Partial<IssuedProviderToken> = {}): IssuedProviderToken {
  return {
    providerDocId: 'ml_doc_1',
    sessionId: 'session_1',
    authorization: 'full',
    validForSeconds: PROVIDER_TOKEN_TTL_SECONDS,
    issuedAt: '2026-05-15T12:00:00.000Z',
    expiresAt: '2026-05-15T12:10:00.000Z',
    clientToken: {
      docId: 'ml_doc_1',
      url: 'ws://api.example.test/d/ml_doc_1/ws/ml_doc_1',
      baseUrl: 'https://api.example.test/d/ml_doc_1',
      token: 'ysweet_token',
      authorization: 'full',
    },
    ...input,
  };
}

describe('collab session API client', () => {
  it('creates a view session without requiring or storing provider credentials', async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      mode: 'view',
      session: { sessionId: 'session_view', clientKind: 'browser', displayName: 'Reader' },
      document: {
        docId: 'doc 1',
        branchId: 'main',
        versionId: null,
        versionNumber: null,
        hash: 'sha256:view',
        markdown: '# View\n',
      },
    }));
    const client = createCollabSessionClient({ apiUrl: 'https://api.example.test', fetcher });

    const session = await client.createSession({
      docId: 'doc 1',
      branchId: 'main',
      mode: 'view',
      displayName: 'Reader',
      token: 'ml_share_view',
    });

    expect(fetcher).toHaveBeenCalledWith(
      'https://api.example.test/api/docs/doc%201/branches/main/collab/session?token=ml_share_view',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({ mode: 'view', clientKind: 'browser', displayName: 'Reader' }),
      }),
    );
    expect(session.mode).toBe('view');
    expect('providerToken' in session).toBe(false);
  });

  it('stores edit refresh tokens separately from Y-Sweet client tokens and refreshes with only the session token', async () => {
    const initialToken = createProviderToken();
    const refreshedToken = createProviderToken({
      clientToken: {
        docId: 'ml_doc_1',
        url: 'ws://api.example.test/d/ml_doc_1/ws/ml_doc_1',
        baseUrl: 'https://api.example.test/d/ml_doc_1',
        token: 'ysweet_token_refreshed',
        authorization: 'full',
      },
      issuedAt: '2026-05-15T12:08:00.000Z',
      expiresAt: '2026-05-15T12:18:00.000Z',
    });
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({
        mode: 'edit',
        session: {
          sessionId: 'session_1',
          clientKind: 'browser',
          displayName: 'Alice',
          refreshToken: 'refresh_session_secret',
        },
        providerToken: initialToken,
      }))
      .mockResolvedValueOnce(jsonResponse({ providerToken: refreshedToken }));
    const client = createCollabSessionClient({ apiUrl: 'https://api.example.test', fetcher });

    const session = await client.createSession({
      docId: 'doc_1',
      branchId: 'branch_1',
      mode: 'edit',
      displayName: 'Alice',
      token: 'ml_access_edit',
    });
    if (session.mode !== 'edit') throw new Error('expected_edit_session');
    const activeSession = createActiveEditSession({ docId: 'doc_1', branchId: 'branch_1' }, session);
    const refreshed = await client.refreshProviderToken(activeSession);

    expect(session.mode).toBe('edit');
    expect(refreshed.clientToken.token).toBe('ysweet_token_refreshed');
    expect(fetcher).toHaveBeenLastCalledWith(
      'https://api.example.test/api/docs/doc_1/branches/branch_1/collab/session/session_1/provider-token/refresh',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({ refreshToken: 'refresh_session_secret' }),
      }),
    );
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).not.toHaveProperty('token');
  });

  it('computes provider token refresh timing from shared policy constants', () => {
    const delayMs = providerTokenRefreshDelayMs(
      createProviderToken(),
      Date.parse('2026-05-15T12:00:00.000Z'),
    );

    expect(delayMs).toBe((PROVIDER_TOKEN_TTL_SECONDS - PROVIDER_TOKEN_REFRESH_MARGIN_SECONDS) * 1000);
  });

  it('refreshes immediately when a token is inside the margin, then falls back to the shared interval', () => {
    const dueToken = createProviderToken({ expiresAt: '2026-05-15T12:00:30.000Z' });
    const delayMs = providerTokenRefreshDelayMs(
      dueToken,
      Date.parse('2026-05-15T12:00:00.000Z'),
    );

    expect(delayMs).toBe(0);
    expect(providerTokenRefreshDelayMs(
      dueToken,
      Date.parse('2026-05-15T12:00:00.000Z'),
      undefined,
      { allowImmediate: false },
    )).toBe(PROVIDER_TOKEN_REFRESH_CHECK_INTERVAL_SECONDS * 1000);
    expect(providerTokenRefreshRetryDelayMs()).toBe(PROVIDER_TOKEN_REFRESH_CHECK_INTERVAL_SECONDS * 1000);
  });

  it('refreshes the caller-provided edit session instead of a later session', async () => {
    const sessionOneToken = createProviderToken({ sessionId: 'session_1' });
    const sessionTwoToken = createProviderToken({
      sessionId: 'session_2',
      clientToken: {
        docId: 'ml_doc_1',
        url: 'ws://api.example.test/d/ml_doc_1/ws/ml_doc_1',
        baseUrl: 'https://api.example.test/d/ml_doc_1',
        token: 'ysweet_token_2',
        authorization: 'full',
      },
    });
    const refreshedToken = createProviderToken({
      sessionId: 'session_1',
      clientToken: {
        docId: 'ml_doc_1',
        url: 'ws://api.example.test/d/ml_doc_1/ws/ml_doc_1',
        baseUrl: 'https://api.example.test/d/ml_doc_1',
        token: 'ysweet_token_1_refreshed',
        authorization: 'full',
      },
    });
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({
        mode: 'edit',
        session: {
          sessionId: 'session_1',
          clientKind: 'browser',
          displayName: 'Alice',
          refreshToken: 'refresh_session_1',
        },
        providerToken: sessionOneToken,
      }))
      .mockResolvedValueOnce(jsonResponse({
        mode: 'edit',
        session: {
          sessionId: 'session_2',
          clientKind: 'browser',
          displayName: 'Alice',
          refreshToken: 'refresh_session_2',
        },
        providerToken: sessionTwoToken,
      }))
      .mockResolvedValueOnce(jsonResponse({ providerToken: refreshedToken }));
    const client = createCollabSessionClient({ apiUrl: 'https://api.example.test', fetcher });

    const firstSession = await client.createSession({
      docId: 'doc_1',
      branchId: 'branch_1',
      mode: 'edit',
      displayName: 'Alice',
    });
    const secondSession = await client.createSession({
      docId: 'doc_2',
      branchId: 'branch_2',
      mode: 'edit',
      displayName: 'Alice',
    });
    if (firstSession.mode !== 'edit' || secondSession.mode !== 'edit') throw new Error('expected_edit_sessions');

    const firstActiveSession = createActiveEditSession({ docId: 'doc_1', branchId: 'branch_1' }, firstSession);
    const refreshed = await client.refreshProviderToken(firstActiveSession);

    expect(refreshed.clientToken.token).toBe('ysweet_token_1_refreshed');
    expect(fetcher).toHaveBeenLastCalledWith(
      'https://api.example.test/api/docs/doc_1/branches/branch_1/collab/session/session_1/provider-token/refresh',
      expect.objectContaining({
        body: JSON.stringify({ refreshToken: 'refresh_session_1' }),
      }),
    );
  });

  it('classifies explicit refresh denials as terminal and transient failures as retryable', () => {
    expect(isTerminalProviderRefreshError(new CollabSessionError(403, 'grant_revoked'))).toBe(true);
    expect(isTerminalProviderRefreshError(new CollabSessionError(404, 'collab_session_not_found'))).toBe(true);
    expect(isTerminalProviderRefreshError(new CollabSessionError(503, 'temporarily_unavailable'))).toBe(false);
    expect(isTerminalProviderRefreshError(new TypeError('network drop'))).toBe(false);
  });

  it('rejects edit-shaped sessions that do not include full provider authorization', async () => {
    const readOnlyToken = createProviderToken({
      authorization: 'read-only',
      clientToken: {
        docId: 'ml_doc_1',
        url: 'ws://api.example.test/d/ml_doc_1/ws/ml_doc_1',
        baseUrl: 'https://api.example.test/d/ml_doc_1',
        token: 'ysweet_token_readonly',
        authorization: 'read-only',
      },
    });
    const fetcher = vi.fn(async () => jsonResponse({
      mode: 'edit',
      session: {
        sessionId: 'session_1',
        clientKind: 'browser',
        displayName: 'Alice',
        refreshToken: 'refresh_session_secret',
      },
      providerToken: readOnlyToken,
    }));
    const client = createCollabSessionClient({ apiUrl: 'https://api.example.test', fetcher });

    await expect(client.createSession({
      docId: 'doc_1',
      branchId: 'branch_1',
      mode: 'edit',
      displayName: 'Alice',
    })).rejects.toThrow('invalid_edit_provider_authorization');
  });
});
