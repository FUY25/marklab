import { describe, expect, it, vi } from 'vitest';
import type { SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import {
  buildYSweetConnectionString,
  loadYSweetProviderProcessConfig,
  readYSweetProviderHealth,
  startYSweetProviderProcess,
  stopYSweetProviderProcess,
  type SpawnedYSweetChild,
} from './ysweet-provider-process';

function expectedYSweetCommand(): string {
  const cwd = process.cwd();
  const apiPackageDir = cwd.endsWith('/apps/api') ? cwd : resolve(cwd, 'apps/api');
  return resolve(apiPackageDir, 'node_modules/.bin/y-sweet');
}

describe('ysweet provider process config', () => {
  it('builds a pinned process-mode y-sweet serve command', () => {
    const config = loadYSweetProviderProcessConfig({
      MARKLAB_YSWEET_PROVIDER_MODE: 'process',
      MARKLAB_YSWEET_SERVER_URL: 'http://127.0.0.1:18080',
      MARKLAB_YSWEET_PUBLIC_URL_PREFIX: 'https://marklab.example.com',
      MARKLAB_YSWEET_STORE_PATH: '/var/lib/marklab/ysweet',
      MARKLAB_YSWEET_AUTH: 'private-key',
      MARKLAB_YSWEET_SERVER_TOKEN: 'server-token',
      MARKLAB_YSWEET_HOST: '127.0.0.1',
      MARKLAB_YSWEET_PORT: '18080',
      MARKLAB_YSWEET_CHECKPOINT_FREQ_SECONDS: '5',
    });

    expect(config).toMatchObject({
      mode: 'process',
      command: expectedYSweetCommand(),
      serverUrl: 'http://127.0.0.1:18080',
      publicUrlPrefix: 'https://marklab.example.com',
      storePath: '/var/lib/marklab/ysweet',
      auth: 'private-key',
      serverToken: 'server-token',
      connectionString: 'ys://server-token@127.0.0.1:18080',
    });
    expect(config.args).toEqual([
      'serve',
      '/var/lib/marklab/ysweet',
      '--host',
      '127.0.0.1',
      '--port',
      '18080',
      '--checkpoint-freq-seconds',
      '5',
      '--url-prefix',
      'https://marklab.example.com',
      '--prod',
    ]);
    expect(config.args).not.toContain('private-key');
  });

  it('supports external-provider mode without a supervised command', () => {
    const config = loadYSweetProviderProcessConfig({
      MARKLAB_YSWEET_PROVIDER_MODE: 'external',
      MARKLAB_YSWEET_SERVER_URL: 'https://ysweet.example.com',
      MARKLAB_YSWEET_SERVER_TOKEN: 'external-token',
    });

    expect(config).toMatchObject({
      mode: 'external',
      serverUrl: 'https://ysweet.example.com',
      serverToken: 'external-token',
      connectionString: 'yss://external-token@ysweet.example.com',
    });
    expect(config.command).toBeUndefined();
    expect(config.args).toEqual([]);
  });

  it('rejects missing required process config', () => {
    expect(() => loadYSweetProviderProcessConfig({
      MARKLAB_YSWEET_PROVIDER_MODE: 'process',
      MARKLAB_YSWEET_AUTH: 'private-key',
      MARKLAB_YSWEET_STORE_PATH: '',
    }, { requireAuth: true, requireStorePath: true })).toThrow('MARKLAB_YSWEET_STORE_PATH');

    expect(() => loadYSweetProviderProcessConfig({
      MARKLAB_YSWEET_PROVIDER_MODE: 'process',
      MARKLAB_YSWEET_STORE_PATH: '/tmp/ysweet',
    }, { requireAuth: true })).toThrow('MARKLAB_YSWEET_AUTH');

    expect(() => loadYSweetProviderProcessConfig({
      MARKLAB_YSWEET_PROVIDER_MODE: 'external',
      MARKLAB_YSWEET_SERVER_URL: 'https://ysweet.example.com',
    }, { requireServerToken: true })).toThrow('MARKLAB_YSWEET_SERVER_TOKEN');
  });

  it('derives y-sweet connection strings from http and https URLs', () => {
    expect(buildYSweetConnectionString({ serverUrl: 'http://127.0.0.1:8080', auth: 'secret' })).toBe('ys://secret@127.0.0.1:8080');
    expect(buildYSweetConnectionString({ serverUrl: 'https://ysweet.example.com/base/', auth: 'space secret' }))
      .toBe('yss://space%20secret@ysweet.example.com/base/');
  });

  it('derives the process port from MARKLAB_YSWEET_SERVER_URL when no explicit port is set', () => {
    const config = loadYSweetProviderProcessConfig({
      MARKLAB_YSWEET_PROVIDER_MODE: 'process',
      MARKLAB_YSWEET_SERVER_URL: 'http://127.0.0.1:18080',
      MARKLAB_YSWEET_STORE_PATH: '/tmp/ysweet',
      MARKLAB_YSWEET_AUTH: 'private-key',
      MARKLAB_YSWEET_SERVER_TOKEN: 'server-token',
    });

    expect(config.port).toBe(18080);
    expect(config.args).toEqual(expect.arrayContaining(['--port', '18080']));
  });

  it('preserves s3 provider store paths without resolving them as local paths', () => {
    const config = loadYSweetProviderProcessConfig({
      MARKLAB_YSWEET_PROVIDER_MODE: 'process',
      MARKLAB_YSWEET_STORE_PATH: 's3://marklab-provider/documents',
      MARKLAB_YSWEET_AUTH: 'private-key',
      MARKLAB_YSWEET_SERVER_TOKEN: 'server-token',
    });

    expect(config.storePath).toBe('s3://marklab-provider/documents');
    expect(config.args).toEqual(expect.arrayContaining(['serve', 's3://marklab-provider/documents']));
  });

  it('rejects skip-gc because the pinned y-sweet server does not support it', () => {
    expect(() => loadYSweetProviderProcessConfig({
      MARKLAB_YSWEET_PROVIDER_MODE: 'process',
      MARKLAB_YSWEET_STORE_PATH: '/tmp/ysweet',
      MARKLAB_YSWEET_AUTH: 'private-key',
      MARKLAB_YSWEET_SERVER_TOKEN: 'server-token',
      MARKLAB_YSWEET_SKIP_GC: 'true',
    })).toThrow('MARKLAB_YSWEET_SKIP_GC=true is not supported');
  });
});

describe('ysweet provider process supervision', () => {
  it('starts and stops the process-mode command without custom sync code', async () => {
    const child = new EventEmitter() as SpawnedYSweetChild;
    child.killed = false;
    child.kill = vi.fn(() => {
      child.killed = true;
      child.emit('exit', 0, null);
      return true;
    });
    const spawn = vi.fn((_command: string, _args: string[], _options: SpawnOptions) => child);
    const config = loadYSweetProviderProcessConfig({
      MARKLAB_YSWEET_PROVIDER_MODE: 'process',
      MARKLAB_YSWEET_STORE_PATH: '/tmp/ysweet',
      MARKLAB_YSWEET_AUTH: 'private-key',
      MARKLAB_YSWEET_SERVER_TOKEN: 'server-token',
    });

    const handle = startYSweetProviderProcess(config, { spawn });

    expect(handle.mode).toBe('process');
    expect(spawn).toHaveBeenCalledWith(expectedYSweetCommand(), expect.arrayContaining(['serve', '/tmp/ysweet']), expect.objectContaining({
      detached: true,
      stdio: 'ignore',
      env: expect.objectContaining({ Y_SWEET_AUTH: 'private-key' }),
    }));
    const spawnArgs = spawn.mock.calls[0]?.[1] ?? [];
    expect(spawnArgs).not.toContain('private-key');
    await stopYSweetProviderProcess(handle);
    expect(child.kill).toHaveBeenCalledWith('SIGINT');
  });

  it('does not leak API process secrets into the y-sweet child environment', () => {
    const originalValues = {
      DATABASE_URL: process.env.DATABASE_URL,
      MARKLAB_ADMIN_TOKEN_HASH: process.env.MARKLAB_ADMIN_TOKEN_HASH,
      MARKLAB_YSWEET_AUTH: process.env.MARKLAB_YSWEET_AUTH,
      MARKLAB_YSWEET_SERVER_TOKEN: process.env.MARKLAB_YSWEET_SERVER_TOKEN,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
      AWS_S3_USE_PATH_STYLE: process.env.AWS_S3_USE_PATH_STYLE,
    };
    process.env.DATABASE_URL = 'postgres://secret';
    process.env.MARKLAB_ADMIN_TOKEN_HASH = 'admin-hash-secret';
    process.env.MARKLAB_YSWEET_AUTH = 'marklab-private-key';
    process.env.MARKLAB_YSWEET_SERVER_TOKEN = 'server-token-secret';
    process.env.OPENAI_API_KEY = 'model-secret';
    process.env.AWS_ACCESS_KEY_ID = 'aws-access';
    process.env.AWS_SECRET_ACCESS_KEY = 'aws-secret';
    process.env.AWS_S3_USE_PATH_STYLE = 'true';

    try {
      const child = new EventEmitter() as SpawnedYSweetChild;
      child.kill = vi.fn(() => true);
      const spawn = vi.fn((_command: string, _args: string[], _options: SpawnOptions) => child);
      const config = loadYSweetProviderProcessConfig({
        MARKLAB_YSWEET_PROVIDER_MODE: 'process',
        MARKLAB_YSWEET_STORE_PATH: 's3://marklab-provider/documents',
        MARKLAB_YSWEET_AUTH: 'private-key',
        MARKLAB_YSWEET_SERVER_TOKEN: 'server-token',
      });

      startYSweetProviderProcess(config, { spawn });

      const childEnv = spawn.mock.calls[0]?.[2].env as NodeJS.ProcessEnv;
      expect(childEnv).toMatchObject({
        Y_SWEET_AUTH: 'private-key',
        AWS_ACCESS_KEY_ID: 'aws-access',
        AWS_SECRET_ACCESS_KEY: 'aws-secret',
        AWS_S3_USE_PATH_STYLE: 'true',
      });
      expect(childEnv.DATABASE_URL).toBeUndefined();
      expect(childEnv.MARKLAB_ADMIN_TOKEN_HASH).toBeUndefined();
      expect(childEnv.MARKLAB_YSWEET_AUTH).toBeUndefined();
      expect(childEnv.MARKLAB_YSWEET_SERVER_TOKEN).toBeUndefined();
      expect(childEnv.OPENAI_API_KEY).toBeUndefined();
    } finally {
      for (const [key, value] of Object.entries(originalValues)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  it('handles child process spawn errors without an unhandled error event', async () => {
    const child = new EventEmitter() as SpawnedYSweetChild;
    child.kill = vi.fn(() => true);
    const spawn = vi.fn(() => child);
    const fetch = vi.fn();
    const config = loadYSweetProviderProcessConfig({
      MARKLAB_YSWEET_PROVIDER_MODE: 'process',
      MARKLAB_YSWEET_STORE_PATH: '/tmp/ysweet',
      MARKLAB_YSWEET_AUTH: 'private-key',
      MARKLAB_YSWEET_SERVER_TOKEN: 'server-token',
    });

    const handle = startYSweetProviderProcess(config, { spawn });

    expect(() => child.emit('error', new Error('spawn ENOENT'))).not.toThrow();
    await expect(readYSweetProviderHealth(handle, { fetch })).resolves.toMatchObject({
      ready: false,
      storeReady: false,
      error: 'provider_process_error:spawn ENOENT',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reads ready and store health through upstream Y-Sweet endpoints', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/ready')) return new Response(JSON.stringify({ ok: true }), { status: 200 });
      if (url.endsWith('/check_store')) {
        expect(init?.method).toBe('POST');
        expect(init?.headers).toMatchObject({ authorization: 'Bearer server-token' });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new Error(`unexpected_url:${url}`);
    });
    const handle = {
      mode: 'external' as const,
      serverUrl: 'http://127.0.0.1:8080',
      serverToken: 'server-token',
      connectionString: 'ys://server-token@127.0.0.1:8080',
    };

    await expect(readYSweetProviderHealth(handle, { fetch })).resolves.toEqual({
      mode: 'external',
      ready: true,
      storeReady: true,
      serverUrl: 'http://127.0.0.1:8080',
      error: null,
    });
  });

  it('reports provider health failures without throwing', async () => {
    const fetch = vi.fn(async () => new Response('down', { status: 503 }));
    const handle = {
      mode: 'external' as const,
      serverUrl: 'http://127.0.0.1:8080',
      connectionString: 'ys://127.0.0.1:8080',
    };

    await expect(readYSweetProviderHealth(handle, { fetch })).resolves.toMatchObject({
      ready: false,
      storeReady: false,
      error: 'provider_ready_failed:503',
    });
  });

  it('reports provider as not ready when the store probe fails', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/ready')) return new Response(JSON.stringify({ ok: true }), { status: 200 });
      if (url.endsWith('/check_store')) return new Response(JSON.stringify({ ok: false }), { status: 500 });
      throw new Error(`unexpected_url:${url}`);
    });
    const handle = {
      mode: 'external' as const,
      serverUrl: 'http://127.0.0.1:8080',
      serverToken: 'server-token',
      connectionString: 'ys://server-token@127.0.0.1:8080',
    };

    await expect(readYSweetProviderHealth(handle, { fetch })).resolves.toEqual({
      mode: 'external',
      ready: false,
      storeReady: false,
      serverUrl: 'http://127.0.0.1:8080',
      error: 'provider_store_failed:500',
    });
  });

  it('times out wedged provider health probes', async () => {
    const fetch = vi.fn(() => new Promise<Response>(() => undefined));
    const handle = {
      mode: 'external' as const,
      serverUrl: 'http://127.0.0.1:8080',
      serverToken: 'server-token',
      connectionString: 'ys://server-token@127.0.0.1:8080',
    };

    const result = await Promise.race([
      readYSweetProviderHealth(handle, { fetch, timeoutMs: 5 }),
      new Promise((resolve) => setTimeout(() => resolve('still_pending'), 25)),
    ]);

    expect(result).toMatchObject({
      ready: false,
      storeReady: false,
      error: 'provider_health_timeout',
    });
  });
});
