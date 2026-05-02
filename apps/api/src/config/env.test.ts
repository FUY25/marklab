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

  it('rejects localhost and loopback public URLs in hosted production mode', () => {
    expectInvalid({ ...productionBaseEnv, MARKLAB_PUBLIC_WEB_URL: 'https://localhost:5175' }, 'localhost');
    expectInvalid({ ...productionBaseEnv, MARKLAB_PUBLIC_API_URL: 'https://127.0.0.1:3001' }, 'loopback');
    expectInvalid({ ...productionBaseEnv, MARKLAB_PUBLIC_RELAY_WS_URL: 'wss://[::1]:3001/relay' }, 'loopback');
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
