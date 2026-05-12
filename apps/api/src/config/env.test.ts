import { describe, expect, it } from 'vitest';
import { loadApiEnv } from './env';
import { loadRelayProductionConfig } from '../relay/relay-production-config';

const productionBaseEnv = {
  NODE_ENV: 'production',
  PORT: '8080',
  DATABASE_URL: 'postgres://marklab:secret@example.neon.tech/marklab?sslmode=require',
  MARKLAB_REQUIRE_AUTH: 'true',
  MARKLAB_PUBLIC_WEB_URL: 'https://marklab.fly.dev',
  MARKLAB_PUBLIC_API_URL: 'https://marklab.fly.dev',
  MARKLAB_PUBLIC_RELAY_WS_URL: 'wss://marklab.fly.dev/relay',
  MARKLAB_YSWEET_PROVIDER_MODE: 'process',
  MARKLAB_YSWEET_SERVER_URL: 'http://127.0.0.1:8080',
  MARKLAB_YSWEET_PUBLIC_URL_PREFIX: 'https://marklab.fly.dev',
  MARKLAB_YSWEET_STORE_PATH: '/data/ysweet',
  MARKLAB_YSWEET_AUTH: 'test-production-provider-private-key',
  MARKLAB_YSWEET_SERVER_TOKEN: 'test-production-provider-server-token',
  MARKLAB_ALLOWED_ORIGINS: 'https://marklab.fly.dev',
  MARKLAB_RELAY_EPHEMERAL_TTL_SECONDS: '86400',
  MARKLAB_RELAY_HOST_LEASE_SECONDS: '30',
  MARKLAB_RELAY_MAX_ROOM_CONNECTIONS: '32',
  MARKLAB_RELAY_MAX_MESSAGE_BYTES: '1048576',
};

function expectInvalid(env: Record<string, string | undefined>, issue: string) {
  expect(() => loadApiEnv(env)).toThrow(issue);
}

describe('loadApiEnv', () => {
  it('rejects missing production DATABASE_URL and public URLs', () => {
    expectInvalid({ NODE_ENV: 'production', MARKLAB_REQUIRE_AUTH: 'true' }, 'DATABASE_URL');
    expectInvalid({ ...productionBaseEnv, DATABASE_URL: undefined }, 'DATABASE_URL');
    expectInvalid({ ...productionBaseEnv, MARKLAB_PUBLIC_WEB_URL: undefined }, 'MARKLAB_PUBLIC_WEB_URL');
    expectInvalid({ ...productionBaseEnv, MARKLAB_PUBLIC_API_URL: undefined }, 'MARKLAB_PUBLIC_API_URL');
    expectInvalid({ ...productionBaseEnv, MARKLAB_PUBLIC_RELAY_WS_URL: undefined }, 'MARKLAB_PUBLIC_RELAY_WS_URL');
    expectInvalid({ ...productionBaseEnv, MARKLAB_YSWEET_PUBLIC_URL_PREFIX: undefined }, 'MARKLAB_YSWEET_PUBLIC_URL_PREFIX');
    expectInvalid({ ...productionBaseEnv, MARKLAB_YSWEET_AUTH: undefined }, 'MARKLAB_YSWEET_AUTH');
    expectInvalid({ ...productionBaseEnv, MARKLAB_YSWEET_SERVER_TOKEN: undefined }, 'MARKLAB_YSWEET_SERVER_TOKEN');
    expectInvalid({ ...productionBaseEnv, MARKLAB_YSWEET_STORE_PATH: undefined }, 'MARKLAB_YSWEET_STORE_PATH');
  });

  it('requires auth in hosted production mode', () => {
    expectInvalid({ ...productionBaseEnv, MARKLAB_REQUIRE_AUTH: 'false' }, 'MARKLAB_REQUIRE_AUTH');
    expectInvalid({ ...productionBaseEnv, MARKLAB_REQUIRE_AUTH: undefined }, 'MARKLAB_REQUIRE_AUTH');
  });

  it('rejects invalid numeric production settings', () => {
    expectInvalid({ ...productionBaseEnv, PORT: '0' }, 'PORT');
    expectInvalid({ ...productionBaseEnv, MARKLAB_RELAY_EPHEMERAL_TTL_SECONDS: '-1' }, 'MARKLAB_RELAY_EPHEMERAL_TTL_SECONDS');
    expectInvalid({ ...productionBaseEnv, MARKLAB_RELAY_HOST_LEASE_SECONDS: '1.5' }, 'MARKLAB_RELAY_HOST_LEASE_SECONDS');
    expectInvalid({ ...productionBaseEnv, MARKLAB_RELAY_MAX_ROOM_CONNECTIONS: 'abc' }, 'MARKLAB_RELAY_MAX_ROOM_CONNECTIONS');
    expectInvalid({ ...productionBaseEnv, MARKLAB_RELAY_MAX_MESSAGE_BYTES: '0' }, 'MARKLAB_RELAY_MAX_MESSAGE_BYTES');
  });

  it('requires a wss public relay URL in hosted production mode', () => {
    expectInvalid({ ...productionBaseEnv, MARKLAB_PUBLIC_RELAY_WS_URL: 'ws://marklab.fly.dev/relay' }, 'wss://');
    expectInvalid({ ...productionBaseEnv, MARKLAB_PUBLIC_RELAY_WS_URL: 'https://marklab.fly.dev/relay' }, 'wss://');
  });

  it('requires an https provider public URL in hosted production mode', () => {
    expectInvalid(
      { ...productionBaseEnv, MARKLAB_YSWEET_PUBLIC_URL_PREFIX: 'http://marklab.fly.dev' },
      'MARKLAB_YSWEET_PUBLIC_URL_PREFIX must use https://',
    );
  });

  it('rejects path-prefixed provider public URLs in API-supervised process mode', () => {
    expectInvalid(
      { ...productionBaseEnv, MARKLAB_YSWEET_PUBLIC_URL_PREFIX: 'https://marklab.fly.dev/ysweet' },
      'MARKLAB_YSWEET_PUBLIC_URL_PREFIX must not include a path',
    );
  });

  it('rejects localhost and loopback public URLs in hosted production mode', () => {
    expectInvalid({ ...productionBaseEnv, MARKLAB_PUBLIC_WEB_URL: 'https://localhost:5175' }, 'localhost');
    expectInvalid({ ...productionBaseEnv, MARKLAB_PUBLIC_API_URL: 'https://127.0.0.1:3001' }, 'loopback');
    expectInvalid({ ...productionBaseEnv, MARKLAB_PUBLIC_RELAY_WS_URL: 'wss://[::1]:3001/relay' }, 'loopback');
    expectInvalid({ ...productionBaseEnv, MARKLAB_YSWEET_PUBLIC_URL_PREFIX: 'http://127.0.0.1:8080' }, 'MARKLAB_YSWEET_PUBLIC_URL_PREFIX');
  });

  it('rejects host mismatches unless MARKLAB_ALLOWED_ORIGINS includes each host', () => {
    expectInvalid(
      {
        ...productionBaseEnv,
        MARKLAB_PUBLIC_WEB_URL: 'https://app.example.com',
        MARKLAB_PUBLIC_API_URL: 'https://api.example.com',
        MARKLAB_PUBLIC_RELAY_WS_URL: 'wss://relay.example.com/relay',
        MARKLAB_ALLOWED_ORIGINS: 'https://app.example.com',
      },
      'MARKLAB_ALLOWED_ORIGINS',
    );

    const env = loadApiEnv({
      ...productionBaseEnv,
      MARKLAB_PUBLIC_WEB_URL: 'https://app.example.com',
      MARKLAB_PUBLIC_API_URL: 'https://api.example.com',
      MARKLAB_PUBLIC_RELAY_WS_URL: 'wss://relay.example.com/relay',
      MARKLAB_ALLOWED_ORIGINS: 'https://app.example.com, https://api.example.com, https://relay.example.com',
    });

    expect(env.allowedOrigins).toEqual([
      'https://app.example.com',
      'https://api.example.com',
      'https://relay.example.com',
    ]);
  });

  it('uses localhost-safe development defaults', () => {
    const env = loadApiEnv({ NODE_ENV: 'development' });

    expect(env.mode).toBe('development');
    expect(env.port).toBe(3001);
    expect(env.databaseUrl).toBeUndefined();
    expect(env.requireAuth).toBe(false);
    expect(env.publicWebUrl).toBe('http://127.0.0.1:5175');
    expect(env.publicApiUrl).toBe('http://127.0.0.1:3001');
    expect(env.publicRelayWebSocketUrl).toBe('ws://127.0.0.1:3001/relay');
    expect(env.allowedOrigins).toContain('http://127.0.0.1:5175');
  });

  it('allows local file mode without DATABASE_URL', () => {
    const env = loadApiEnv({
      NODE_ENV: 'production',
      MARKLAB_LOCAL_FILE: '/tmp/doc.md',
      MARKLAB_REQUIRE_AUTH: 'false',
      MARKLAB_PUBLIC_WEB_URL: 'http://127.0.0.1:5175',
      MARKLAB_PUBLIC_API_URL: 'http://127.0.0.1:3001',
      MARKLAB_PUBLIC_RELAY_WS_URL: 'ws://127.0.0.1:3001/relay',
    });

    expect(env.mode).toBe('local');
    expect(env.databaseUrl).toBeUndefined();
    expect(env.requireAuth).toBe(false);
  });

  it('loads the Fly and Neon production happy path', () => {
    const env = loadApiEnv(productionBaseEnv);

    expect(env).toMatchObject({
      mode: 'production',
      port: 8080,
      databaseUrl: productionBaseEnv.DATABASE_URL,
      requireAuth: true,
      publicWebUrl: 'https://marklab.fly.dev',
      publicApiUrl: 'https://marklab.fly.dev',
      publicRelayWebSocketUrl: 'wss://marklab.fly.dev/relay',
      ysweetProviderMode: 'process',
      ysweetServerUrl: 'http://127.0.0.1:8080',
      ysweetPublicUrlPrefix: 'https://marklab.fly.dev',
      ysweetStorePath: '/data/ysweet',
      ysweetAuth: 'test-production-provider-private-key',
      ysweetServerToken: 'test-production-provider-server-token',
      ysweetConnectionString: 'ys://test-production-provider-server-token@127.0.0.1:8080',
      ysweetHost: '127.0.0.1',
      ysweetPort: 8080,
      ysweetCheckpointFreqSeconds: 10,
      ysweetSkipGc: false,
      relayEphemeralTtlSeconds: 86400,
      relayHostLeaseSeconds: 30,
      relayMaxRoomConnections: 32,
      relayMaxMessageBytes: 1048576,
    });
  });

  it('allows explicit loopback URLs only for local production smoke', () => {
    const env = loadApiEnv({
      ...productionBaseEnv,
      MARKLAB_LOCAL_PRODUCTION_SMOKE: 'true',
      MARKLAB_PUBLIC_WEB_URL: 'http://127.0.0.1:8080',
      MARKLAB_PUBLIC_API_URL: 'http://127.0.0.1:3001',
      MARKLAB_PUBLIC_RELAY_WS_URL: 'ws://127.0.0.1:3001/relay',
      MARKLAB_ALLOWED_ORIGINS: 'http://127.0.0.1:8080',
    });

    expect(env).toMatchObject({
      mode: 'production',
      publicWebUrl: 'http://127.0.0.1:8080',
      publicApiUrl: 'http://127.0.0.1:3001',
      publicRelayWebSocketUrl: 'ws://127.0.0.1:3001/relay',
    });
  });

  it('allows local production smoke to run without provider secrets', () => {
    const env = loadApiEnv({
      NODE_ENV: 'production',
      PORT: '3001',
      DATABASE_URL: 'postgres://marklab:marklab@127.0.0.1:54329/marklab',
      MARKLAB_LOCAL_PRODUCTION_SMOKE: 'true',
      MARKLAB_REQUIRE_AUTH: 'true',
      MARKLAB_PUBLIC_WEB_URL: 'http://127.0.0.1:8080',
      MARKLAB_PUBLIC_API_URL: 'http://127.0.0.1:3001',
      MARKLAB_PUBLIC_RELAY_WS_URL: 'ws://127.0.0.1:3001/relay',
      MARKLAB_ALLOWED_ORIGINS: 'http://127.0.0.1:8080',
      MARKLAB_RELAY_EPHEMERAL_TTL_SECONDS: '86400',
      MARKLAB_RELAY_HOST_LEASE_SECONDS: '30',
      MARKLAB_RELAY_MAX_ROOM_CONNECTIONS: '32',
      MARKLAB_RELAY_MAX_MESSAGE_BYTES: '1048576',
    });

    expect(env).toMatchObject({
      mode: 'production',
      ysweetProviderMode: 'disabled',
    });
    expect(env.ysweetConnectionString).toBeUndefined();
  });

  it('supports an externally managed provider in production', () => {
    const env = loadApiEnv({
      ...productionBaseEnv,
      MARKLAB_YSWEET_PROVIDER_MODE: 'external',
      MARKLAB_YSWEET_SERVER_URL: 'https://ysweet.example.com',
      MARKLAB_YSWEET_PUBLIC_URL_PREFIX: undefined,
      MARKLAB_YSWEET_STORE_PATH: undefined,
      MARKLAB_YSWEET_AUTH: undefined,
      MARKLAB_YSWEET_SERVER_TOKEN: 'external-token',
    });

    expect(env).toMatchObject({
      ysweetProviderMode: 'external',
      ysweetServerUrl: 'https://ysweet.example.com',
      ysweetPublicUrlPrefix: 'https://ysweet.example.com',
      ysweetServerToken: 'external-token',
      ysweetConnectionString: 'yss://external-token@ysweet.example.com',
    });
    expect(env.ysweetStorePath).toBeUndefined();
  });
});

describe('loadRelayProductionConfig', () => {
  it('returns the production relay limits and public URL contract', () => {
    expect(loadRelayProductionConfig(productionBaseEnv)).toEqual({
      publicWebUrl: 'https://marklab.fly.dev',
      publicApiUrl: 'https://marklab.fly.dev',
      publicRelayWebSocketUrl: 'wss://marklab.fly.dev/relay',
      allowedOrigins: ['https://marklab.fly.dev'],
      ephemeralTtlSeconds: 86400,
      hostLeaseSeconds: 30,
      maxRoomConnections: 32,
      maxMessageBytes: 1048576,
    });
  });
});
