import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildOidcAuthorizationUrl, exchangeOidcCode } from './oidc-service';

const config = {
  issuer: 'https://login.example.test',
  clientId: 'marklab-client',
  clientSecret: 'marklab-secret',
  redirectUri: 'https://marklab.example.test/auth/callback',
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OIDC service', () => {
  it('builds the authorization URL from discovery when no explicit endpoint is configured', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json({
      issuer: config.issuer,
      authorization_endpoint: 'https://oauth.example.test/authorize',
    }));
    vi.stubGlobal('fetch', fetch);

    const authorizationUrl = await buildOidcAuthorizationUrl({
      config,
      state: 'state_1',
      codeVerifier: 'verifier_1',
    });

    const url = new URL(authorizationUrl);
    expect(url.origin + url.pathname).toBe('https://oauth.example.test/authorize');
    expect(url.searchParams.get('state')).toBe('state_1');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('exchanges a verified OIDC email claim with PKCE code verifier', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({
        issuer: config.issuer,
        token_endpoint: 'https://login.example.test/token',
        userinfo_endpoint: 'https://login.example.test/userinfo',
      }))
      .mockResolvedValueOnce(json({ access_token: 'provider_access_token' }))
      .mockResolvedValueOnce(json({
        sub: 'subject_1',
        email: 'ALICE@example.com',
        email_verified: true,
        name: 'Alice',
      }));
    vi.stubGlobal('fetch', fetch);

    await expect(exchangeOidcCode({
      code: 'code_1',
      codeVerifier: 'verifier_1',
      config,
    })).resolves.toEqual({
      provider: config.issuer,
      subject: 'subject_1',
      email: 'ALICE@example.com',
      name: 'Alice',
    });

    const tokenBody = fetch.mock.calls[1]?.[1]?.body as URLSearchParams;
    expect(tokenBody.get('code_verifier')).toBe('verifier_1');
  });

  it('rejects unverified OIDC email claims', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({
        issuer: config.issuer,
        token_endpoint: 'https://login.example.test/token',
        userinfo_endpoint: 'https://login.example.test/userinfo',
      }))
      .mockResolvedValueOnce(json({ access_token: 'provider_access_token' }))
      .mockResolvedValueOnce(json({
        sub: 'subject_1',
        email: 'alice@example.com',
        email_verified: false,
      }));
    vi.stubGlobal('fetch', fetch);

    await expect(exchangeOidcCode({
      code: 'code_1',
      codeVerifier: 'verifier_1',
      config,
    })).rejects.toThrow('oidc_unverified_email');
  });

  it('maps malformed OIDC provider responses to controlled login failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('{not-json', { status: 200 })));

    await expect(exchangeOidcCode({
      code: 'code_1',
      codeVerifier: 'verifier_1',
      config,
    })).rejects.toThrow('oidc_discovery_failed');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json({
      issuer: config.issuer,
      token_endpoint: 'not a url',
      userinfo_endpoint: 'https://login.example.test/userinfo',
    })));

    await expect(exchangeOidcCode({
      code: 'code_1',
      codeVerifier: 'verifier_1',
      config,
    })).rejects.toThrow('oidc_discovery_failed');
  });

  it('maps OIDC provider network failures to controlled login failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('network down')));

    await expect(buildOidcAuthorizationUrl({
      config,
      state: 'state_1',
      codeVerifier: 'verifier_1',
    })).rejects.toThrow('oidc_discovery_failed');

    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(json({
        issuer: config.issuer,
        token_endpoint: 'https://login.example.test/token',
        userinfo_endpoint: 'https://login.example.test/userinfo',
      }))
      .mockRejectedValueOnce(new Error('network down')));

    await expect(exchangeOidcCode({
      code: 'code_1',
      codeVerifier: 'verifier_1',
      config,
    })).rejects.toThrow('oidc_code_exchange_failed');

    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(json({
        issuer: config.issuer,
        token_endpoint: 'https://login.example.test/token',
        userinfo_endpoint: 'https://login.example.test/userinfo',
      }))
      .mockResolvedValueOnce(json({ access_token: 'provider_access_token' }))
      .mockRejectedValueOnce(new Error('network down')));

    await expect(exchangeOidcCode({
      code: 'code_1',
      codeVerifier: 'verifier_1',
      config,
    })).rejects.toThrow('oidc_userinfo_failed');
  });
});
