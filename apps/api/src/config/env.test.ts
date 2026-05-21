import { describe, expect, it } from 'vitest';
import { loadApiEnv } from './env';

const productionBaseEnv = {
  NODE_ENV: 'production',
  PORT: '8080',
  DATABASE_URL: 'postgres://marklab:secret@example.neon.tech/marklab?sslmode=require',
  MARKLAB_REQUIRE_AUTH: 'true',
  MARKLAB_PUBLIC_WEB_URL: 'https://marklab.fly.dev',
  MARKLAB_PUBLIC_API_URL: 'https://marklab.fly.dev',
  MARKLAB_YSWEET_PROVIDER_MODE: 'process',
  MARKLAB_YSWEET_SERVER_URL: 'http://127.0.0.1:8080',
  MARKLAB_YSWEET_PUBLIC_URL_PREFIX: 'https://marklab.fly.dev',
  MARKLAB_YSWEET_STORE_PATH: '/data/ysweet',
  MARKLAB_YSWEET_AUTH: 'test-production-provider-private-key',
  MARKLAB_YSWEET_SERVER_TOKEN: 'test-production-provider-server-token',
  MARKLAB_ALLOWED_ORIGINS: 'https://marklab.fly.dev',
};

function expectInvalid(env: Record<string, string | undefined>, issue: string) {
  expect(() => loadApiEnv(env)).toThrow(issue);
}

describe('loadApiEnv', () => {
  it('rejects missing production database, public URLs, and provider secrets', () => {
    expectInvalid({ NODE_ENV: 'production', MARKLAB_REQUIRE_AUTH: 'true' }, 'DATABASE_URL');
    expectInvalid({ ...productionBaseEnv, DATABASE_URL: undefined }, 'DATABASE_URL');
    expectInvalid({ ...productionBaseEnv, MARKLAB_PUBLIC_WEB_URL: undefined }, 'MARKLAB_PUBLIC_WEB_URL');
    expectInvalid({ ...productionBaseEnv, MARKLAB_PUBLIC_API_URL: undefined }, 'MARKLAB_PUBLIC_API_URL');
    expectInvalid({ ...productionBaseEnv, MARKLAB_YSWEET_PUBLIC_URL_PREFIX: undefined }, 'MARKLAB_YSWEET_PUBLIC_URL_PREFIX');
    expectInvalid({ ...productionBaseEnv, MARKLAB_YSWEET_AUTH: undefined }, 'MARKLAB_YSWEET_AUTH');
    expectInvalid({ ...productionBaseEnv, MARKLAB_YSWEET_SERVER_TOKEN: undefined }, 'MARKLAB_YSWEET_SERVER_TOKEN');
    expectInvalid({ ...productionBaseEnv, MARKLAB_YSWEET_STORE_PATH: undefined }, 'MARKLAB_YSWEET_STORE_PATH');
  });

  it('requires auth in hosted production mode', () => {
    expectInvalid({ ...productionBaseEnv, MARKLAB_REQUIRE_AUTH: 'false' }, 'MARKLAB_REQUIRE_AUTH');
    expectInvalid({ ...productionBaseEnv, MARKLAB_REQUIRE_AUTH: undefined }, 'MARKLAB_REQUIRE_AUTH');
  });

  it('rejects invalid primitive production settings', () => {
    expectInvalid({ ...productionBaseEnv, PORT: '0' }, 'PORT');
    expectInvalid({ ...productionBaseEnv, PORT: '1.5' }, 'PORT');
    expectInvalid({ ...productionBaseEnv, MARKLAB_REQUIRE_AUTH: 'yes' }, 'MARKLAB_REQUIRE_AUTH');
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

  it('requires process-mode provider public URL to share the API origin', () => {
    expectInvalid(
      {
        ...productionBaseEnv,
        MARKLAB_YSWEET_PUBLIC_URL_PREFIX: 'https://typo.example.com',
        MARKLAB_ALLOWED_ORIGINS: 'https://marklab.fly.dev, https://typo.example.com',
      },
      'MARKLAB_YSWEET_PUBLIC_URL_PREFIX must match MARKLAB_PUBLIC_API_URL origin in process mode',
    );
  });

  it('rejects localhost and loopback public URLs in hosted production mode', () => {
    expectInvalid({ ...productionBaseEnv, MARKLAB_PUBLIC_WEB_URL: 'https://localhost:5175' }, 'localhost');
    expectInvalid({ ...productionBaseEnv, MARKLAB_PUBLIC_API_URL: 'https://127.0.0.1:3001' }, 'loopback');
    expectInvalid({ ...productionBaseEnv, MARKLAB_YSWEET_PUBLIC_URL_PREFIX: 'http://127.0.0.1:8080' }, 'MARKLAB_YSWEET_PUBLIC_URL_PREFIX');
  });

  it('rejects host mismatches unless MARKLAB_ALLOWED_ORIGINS includes each host', () => {
    expectInvalid(
      {
        ...productionBaseEnv,
        MARKLAB_PUBLIC_WEB_URL: 'https://app.example.com',
        MARKLAB_PUBLIC_API_URL: 'https://api.example.com',
        MARKLAB_YSWEET_PUBLIC_URL_PREFIX: 'https://api.example.com',
        MARKLAB_ALLOWED_ORIGINS: 'https://app.example.com',
      },
      'MARKLAB_ALLOWED_ORIGINS',
    );

    const env = loadApiEnv({
      ...productionBaseEnv,
      MARKLAB_PUBLIC_WEB_URL: 'https://app.example.com',
      MARKLAB_PUBLIC_API_URL: 'https://api.example.com',
      MARKLAB_YSWEET_PUBLIC_URL_PREFIX: 'https://api.example.com',
      MARKLAB_ALLOWED_ORIGINS: 'https://app.example.com, https://api.example.com',
    });

    expect(env.allowedOrigins).toEqual([
      'https://app.example.com',
      'https://api.example.com',
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
    expect(env.allowedOrigins).toContain('http://127.0.0.1:5175');
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
    });
  });

  it('allows local production smoke to use loopback public URLs with process-mode provider config', () => {
    const env = loadApiEnv({
      ...productionBaseEnv,
      PORT: '3001',
      DATABASE_URL: 'postgres://marklab:marklab@postgres:5432/marklab',
      MARKLAB_LOCAL_PRODUCTION_SMOKE: 'true',
      MARKLAB_PUBLIC_WEB_URL: 'http://127.0.0.1:3001',
      MARKLAB_PUBLIC_API_URL: 'http://127.0.0.1:3001',
      MARKLAB_YSWEET_SERVER_URL: 'http://127.0.0.1:8080',
      MARKLAB_YSWEET_PUBLIC_URL_PREFIX: 'http://127.0.0.1:3001',
      MARKLAB_YSWEET_STORE_PATH: '/data/ysweet',
      MARKLAB_ALLOWED_ORIGINS: 'http://127.0.0.1:3001',
    });

    expect(env).toMatchObject({
      mode: 'production',
      port: 3001,
      requireAuth: true,
      publicWebUrl: 'http://127.0.0.1:3001',
      publicApiUrl: 'http://127.0.0.1:3001',
      ysweetProviderMode: 'process',
      ysweetServerUrl: 'http://127.0.0.1:8080',
      ysweetPublicUrlPrefix: 'http://127.0.0.1:3001',
      ysweetStorePath: '/data/ysweet',
    });
  });

  it('rejects externally managed provider mode in hosted production alpha', () => {
    expectInvalid({
      ...productionBaseEnv,
      MARKLAB_YSWEET_PROVIDER_MODE: 'external',
      MARKLAB_YSWEET_SERVER_URL: 'https://ysweet.example.com',
      MARKLAB_YSWEET_PUBLIC_URL_PREFIX: undefined,
      MARKLAB_YSWEET_STORE_PATH: undefined,
      MARKLAB_YSWEET_AUTH: undefined,
      MARKLAB_YSWEET_SERVER_TOKEN: 'external-token',
    }, 'MARKLAB_YSWEET_PROVIDER_MODE must be process');
  });
});
