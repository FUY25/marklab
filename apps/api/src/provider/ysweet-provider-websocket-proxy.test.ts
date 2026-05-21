import { afterEach, describe, expect, it } from 'vitest';
import { sha256Hex } from '@marklab/shared/src/hash';
import {
  buildYSweetProviderProxyHeaders,
  buildYSweetProviderResponseHeaders,
  buildYSweetProviderWebSocketTarget,
  isYSweetProviderHttpPath,
  isYSweetProviderWebSocketOriginAllowed,
  isYSweetProviderWebSocketPath,
} from './ysweet-provider-websocket-proxy';

const originalAdminHash = process.env.MARKLAB_ADMIN_TOKEN_HASH;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

afterEach(() => {
  restoreEnv('MARKLAB_ADMIN_TOKEN_HASH', originalAdminHash);
});

describe('ysweet provider websocket proxy helpers', () => {
  it('recognizes only upstream Y-Sweet websocket document paths', () => {
    expect(isYSweetProviderWebSocketPath('/doc/ws/abc?token=secret')).toBe(true);
    expect(isYSweetProviderWebSocketPath('/doc/ws/')).toBe(true);
    expect(isYSweetProviderWebSocketPath('/d/doc_1/ws/doc_1?token=secret')).toBe(true);
    expect(isYSweetProviderWebSocketPath('/d/doc_1/ws/doc_2?token=secret')).toBe(true);
    expect(isYSweetProviderWebSocketPath('/d/doc_1/update')).toBe(false);
    expect(isYSweetProviderWebSocketPath('/doc/api/abc')).toBe(false);
    expect(isYSweetProviderWebSocketPath(undefined)).toBe(false);
  });

  it('builds an internal provider target while preserving path and query', () => {
    expect(buildYSweetProviderWebSocketTarget('http://127.0.0.1:8080/base/', '/doc/ws/doc_1?token=secret').toString())
      .toBe('http://127.0.0.1:8080/base/doc/ws/doc_1?token=secret');
    expect(buildYSweetProviderWebSocketTarget('http://127.0.0.1:8080/base/', '/d/doc_1/ws/doc_1?token=secret').toString())
      .toBe('http://127.0.0.1:8080/base/d/doc_1/ws/doc_1?token=secret');
    expect(buildYSweetProviderWebSocketTarget('http://127.0.0.1:8080/base/', '/d/doc_1/as-update?z=cache').toString())
      .toBe('http://127.0.0.1:8080/base/d/doc_1/as-update?z=cache');
    expect(buildYSweetProviderWebSocketTarget('https://provider.example.com/ysweet/', '/d/doc_1/ws/doc_1?token=secret').toString())
      .toBe('https://provider.example.com/ysweet/d/doc_1/ws/doc_1?token=secret');
  });

  it('does not forward MarkLab control-plane cookies to the provider', () => {
    expect(buildYSweetProviderProxyHeaders({
      host: 'marklab.example.test',
      cookie: 'marklab_session=ml_user_secret; other=value',
      accept: 'application/json',
    }, '127.0.0.1:8080')).toEqual({
      host: '127.0.0.1:8080',
      accept: 'application/json',
    });
  });

  it('does not forward control-plane authorization headers to the provider', () => {
    for (const authorization of [
      'Bearer ml_user_secret',
      'Bearer ml_share_secret',
      'Bearer ml_access_secret',
      'Bearer ml_agent_secret',
      'Bearer admin-secret',
      'Bearer legacy-user-token',
    ]) {
      expect(buildYSweetProviderProxyHeaders({
        host: 'marklab.example.test',
        authorization,
      }, '127.0.0.1:8080')).toEqual({
        host: '127.0.0.1:8080',
      });
    }
  });

  it('preserves provider-native HTTP bearer tokens when explicitly allowed', () => {
    expect(buildYSweetProviderProxyHeaders({
      host: 'marklab.example.test',
      authorization: 'Bearer ysweet-client-token',
    }, '127.0.0.1:8080', { preserveProviderAuthorization: true })).toEqual({
      host: '127.0.0.1:8080',
      authorization: 'Bearer ysweet-client-token',
    });
  });

  it('does not preserve known MarkLab bearer tokens on provider HTTP requests', () => {
    process.env.MARKLAB_ADMIN_TOKEN_HASH = sha256Hex('admin-secret');

    for (const authorization of [
      'Bearer ml_user_secret',
      'Bearer ml_share_secret',
      'Bearer ml_access_secret',
      'Bearer ml_agent_secret',
      'Bearer ml_workspace_secret',
      'Bearer admin-secret',
    ]) {
      expect(buildYSweetProviderProxyHeaders({
        host: 'marklab.example.test',
        authorization,
      }, '127.0.0.1:8080', { preserveProviderAuthorization: true })).toEqual({
        host: '127.0.0.1:8080',
      });
    }
  });

  it('does not forward provider Set-Cookie response headers back to browsers', () => {
    expect(buildYSweetProviderResponseHeaders({
      'set-cookie': ['marklab_session=evil; Path=/', 'provider_cookie=value'],
      upgrade: 'websocket',
    })).toEqual({
      upgrade: 'websocket',
    });
    expect(buildYSweetProviderResponseHeaders({
      'Set-Cookie': 'marklab_oidc_state=evil; Path=/api/auth/oidc',
      'content-type': 'application/octet-stream',
    })).toEqual({
      'content-type': 'application/octet-stream',
    });
  });

  it('recognizes only token-scoped Y-Sweet document HTTP paths', () => {
    expect(isYSweetProviderHttpPath('/d/doc_1/as-update?z=cache')).toBe(true);
    expect(isYSweetProviderHttpPath('/d/doc_1/update')).toBe(true);
    expect(isYSweetProviderHttpPath('/doc/doc_1/as-update')).toBe(true);
    expect(isYSweetProviderHttpPath('/doc/doc_1/update?token=secret')).toBe(true);
    expect(isYSweetProviderHttpPath('/doc/new')).toBe(false);
    expect(isYSweetProviderHttpPath('/doc/doc_1/auth')).toBe(false);
    expect(isYSweetProviderHttpPath('/check_store')).toBe(false);
    expect(isYSweetProviderHttpPath('/ready')).toBe(false);
    expect(isYSweetProviderHttpPath('/d/doc_1/ws/doc_1?token=secret')).toBe(false);
    expect(isYSweetProviderHttpPath(undefined)).toBe(false);
  });

  it('blocks cross-origin browser provider upgrades when origin enforcement is enabled', () => {
    expect(isYSweetProviderWebSocketOriginAllowed({
      origin: 'https://marklab.example.com/editor',
      allowedOrigins: ['https://marklab.example.com'],
      enforceAllowedOrigins: true,
    })).toBe(true);
    expect(isYSweetProviderWebSocketOriginAllowed({
      origin: 'https://evil.example.com',
      allowedOrigins: ['https://marklab.example.com'],
      enforceAllowedOrigins: true,
    })).toBe(false);
    expect(isYSweetProviderWebSocketOriginAllowed({
      origin: 'not a url',
      allowedOrigins: ['https://marklab.example.com'],
      enforceAllowedOrigins: true,
    })).toBe(false);
    expect(isYSweetProviderWebSocketOriginAllowed({
      origin: undefined,
      allowedOrigins: ['https://marklab.example.com'],
      enforceAllowedOrigins: true,
    })).toBe(true);
    expect(isYSweetProviderWebSocketOriginAllowed({
      origin: 'https://evil.example.com',
      allowedOrigins: [],
      enforceAllowedOrigins: false,
    })).toBe(true);
  });
});
