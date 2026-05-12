import { describe, expect, it } from 'vitest';
import {
  buildYSweetProviderWebSocketTarget,
  isYSweetProviderHttpPath,
  isYSweetProviderWebSocketOriginAllowed,
  isYSweetProviderWebSocketPath,
} from './ysweet-provider-websocket-proxy';

describe('ysweet provider websocket proxy helpers', () => {
  it('recognizes only upstream Y-Sweet websocket document paths', () => {
    expect(isYSweetProviderWebSocketPath('/doc/ws/abc?token=secret')).toBe(true);
    expect(isYSweetProviderWebSocketPath('/doc/ws/')).toBe(true);
    expect(isYSweetProviderWebSocketPath('/d/doc_1/ws/doc_1?token=secret')).toBe(true);
    expect(isYSweetProviderWebSocketPath('/d/doc_1/ws/doc_2?token=secret')).toBe(true);
    expect(isYSweetProviderWebSocketPath('/d/doc_1/update')).toBe(false);
    expect(isYSweetProviderWebSocketPath('/doc/api/abc')).toBe(false);
    expect(isYSweetProviderWebSocketPath('/relay/abc')).toBe(false);
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
