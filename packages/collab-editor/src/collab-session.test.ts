import { describe, expect, it, vi } from 'vitest';
import {
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

describe('shared collaboration session client', () => {
  it('creates native app edit sessions with clientKind app and refreshes with only the session refresh token', async () => {
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
          clientKind: 'app',
          displayName: 'MarkLab.app',
          refreshToken: 'refresh_session_secret',
        },
        providerToken: initialToken,
      }))
      .mockResolvedValueOnce(jsonResponse({ providerToken: refreshedToken }));
    const client = createCollabSessionClient({ apiUrl: 'https://api.example.test', clientKind: 'app', fetcher });

    const session = await client.createSession({
      docId: 'doc_1',
      branchId: 'branch_1',
      mode: 'edit',
      displayName: 'MarkLab.app',
      token: 'ml_access_edit',
    });
    if (session.mode !== 'edit') throw new Error('expected_edit_session');
    const activeSession = createActiveEditSession({ docId: 'doc_1', branchId: 'branch_1' }, session);
    const refreshed = await client.refreshProviderToken(activeSession);

    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      'https://api.example.test/api/docs/doc_1/branches/branch_1/collab/session?token=ml_access_edit',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({ mode: 'edit', clientKind: 'app', displayName: 'MarkLab.app' }),
      }),
    );
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

  it('creates public view sessions without accepting provider credentials', async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      mode: 'view',
      session: { sessionId: 'session_view', clientKind: 'app', displayName: 'Reader' },
      providerToken: createProviderToken(),
      document: {
        docId: 'doc_1',
        branchId: 'main',
        versionId: null,
        versionNumber: null,
        hash: 'sha256:view',
        markdown: '# View\n',
      },
    }));
    const client = createCollabSessionClient({ apiUrl: 'https://api.example.test', clientKind: 'app', fetcher });

    const session = await client.createSession({
      docId: 'doc_1',
      branchId: 'main',
      mode: 'view',
      displayName: 'Reader',
      token: 'ml_share_view',
    });

    expect(session.mode).toBe('view');
    expect('providerToken' in session).toBe(false);
  });

  it('uses the shared token policy for refresh timing and retry classification', async () => {
    expect(providerTokenRefreshDelayMs(
      createProviderToken(),
      Date.parse('2026-05-15T12:00:00.000Z'),
    )).toBe((PROVIDER_TOKEN_TTL_SECONDS - PROVIDER_TOKEN_REFRESH_MARGIN_SECONDS) * 1000);
    expect(providerTokenRefreshRetryDelayMs()).toBe(PROVIDER_TOKEN_REFRESH_CHECK_INTERVAL_SECONDS * 1000);

    const fetcher = vi.fn(async () => new Response('forbidden', { status: 403 }));
    const client = createCollabSessionClient({ apiUrl: 'https://api.example.test', fetcher });
    const activeSession = {
      docId: 'doc_1',
      branchId: 'branch_1',
      sessionId: 'session_1',
      refreshToken: 'refresh_session_secret',
    };

    await client.refreshProviderToken(activeSession).catch((error: unknown) => {
      expect(isTerminalProviderRefreshError(error)).toBe(true);
    });
  });
});
