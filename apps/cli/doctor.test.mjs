import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runDoctor } from './doctor.mjs';

async function startHealthServer(body) {
  const server = http.createServer((req, res) => {
    if (req.url === '/healthz') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  const port = await new Promise((resolvePort, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') reject(new Error('missing_port'));
      else resolvePort(address.port);
    });
  });
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  };
}

describe('doctor command checks', () => {
  it('reports errors and warnings separately without mutating the target markdown', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'marklab-doctor-'));
    const filePath = join(directory, 'README.md');
    await writeFile(filePath, '# Doctor\n', 'utf8');
    const before = await readFile(filePath, 'utf8');

    const result = await runDoctor(
      { file: filePath },
      {
        env: {
          MARKLAB_DOCTOR_SKIP_NETWORK: '1',
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(Array.isArray(result.errors)).toBe(true);
    expect(Array.isArray(result.warnings)).toBe(true);
    expect(result.checks.map((check) => check.name)).toEqual(expect.arrayContaining([
      'node_version',
      'installation_mode',
      'native_app',
      'native_url_scheme',
      'pilot_target',
      'api_health',
      'target_file_permissions',
      'watcher_temp_change',
    ]));
    await expect(readFile(filePath, 'utf8')).resolves.toBe(before);
  });

  it('reports hosted pilot health from /healthz', async () => {
    const server = await startHealthServer({
      ok: true,
      schema: { ready: true, missing: [] },
      provider: { ready: true, storeReady: true },
      database: { ready: true },
    });

    try {
      const result = await runDoctor(
        {},
        {
          env: {
            MARKLAB_CONTROL_PLANE_API_URL: server.url,
            MARKLAB_PUBLIC_WEB_URL: 'https://app.example.test',
          },
        },
      );

      expect(result.ok).toBe(true);
      expect(result.checks).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: 'pilot_target',
          status: 'ok',
          details: expect.objectContaining({
            apiUrl: server.url,
            webUrl: 'https://app.example.test',
            source: 'environment',
          }),
        }),
        expect.objectContaining({
          name: 'api_health',
          status: 'ok',
          details: expect.objectContaining({
            schemaReady: true,
            providerReady: true,
            providerStoreReady: true,
          }),
        }),
      ]));
    } finally {
      await server.close();
    }
  });

  it('reports configured native app bundle path and join URL scheme', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'marklab-doctor-app-'));
    const appPath = join(directory, 'MarkLab.app');
    await mkdir(appPath);

    const result = await runDoctor(
      {},
      {
        env: {
          MARKLAB_APP_PATH: appPath,
          MARKLAB_APP_URL_SCHEME: 'marklab',
          MARKLAB_DOCTOR_SKIP_NETWORK: '1',
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'native_app',
        status: 'ok',
        details: expect.objectContaining({
          appPath,
          source: 'environment',
        }),
      }),
      expect.objectContaining({
        name: 'native_url_scheme',
        status: 'ok',
        details: expect.objectContaining({
          scheme: 'marklab',
          example: expect.stringContaining('marklab://join?url='),
        }),
      }),
    ]));
  });

  it('fails doctor when the configured native join URL scheme is invalid', async () => {
    await expect(
      runDoctor(
        {},
        {
          env: {
            MARKLAB_APP_URL_SCHEME: '1 bad',
            MARKLAB_DOCTOR_SKIP_NETWORK: '1',
          },
        },
      ),
    ).rejects.toMatchObject({
      code: 'doctor_failed',
      details: {
        errors: [expect.objectContaining({ code: 'native_url_scheme_invalid' })],
      },
    });
  });
});
