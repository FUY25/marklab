import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createDaemonEntry, writeDaemonRegistry } from './daemon-supervisor.mjs';
import { parseCliArgs } from './marklab.mjs';
import { syncStateForDaemon } from './recent-files.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');

async function createRegistryFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'marklab-agent-conflict-'));
  const file = join(directory, 'README.md');
  await writeFile(file, '# Conflict\n', 'utf8');
  const realFile = await realpath(file);
  const registryPath = join(directory, 'registry.json');
  return { directory, file, realFile, registryPath };
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server_address_unavailable');
  return address.port;
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

function jsonResponse(response, body, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function runMarklab(args, env) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['apps/cli/marklab.mjs', ...args], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('agent conflict command', () => {
  it('parses conflict as a JSON-capable agent command', () => {
    expect(parseCliArgs(['conflict', 'README.md', '--json'])).toEqual({
      command: 'conflict',
      file: 'README.md',
      json: true,
      resolveFile: null,
      resolveFileFlagPresent: false,
      useLocal: false,
      useShared: false,
    });
  });

  it('parses conflict resolution actions for agents', () => {
    expect(parseCliArgs(['conflict', 'README.md', '--use-shared', '--json'])).toMatchObject({
      command: 'conflict',
      file: 'README.md',
      useShared: true,
      useLocal: false,
      resolveFile: null,
      json: true,
    });
    expect(parseCliArgs(['conflict', 'README.md', '--use-local', '--json'])).toMatchObject({
      command: 'conflict',
      file: 'README.md',
      useShared: false,
      useLocal: true,
      resolveFile: null,
      json: true,
    });
    expect(parseCliArgs(['conflict', 'README.md', '--resolve-file', 'merged.md', '--json'])).toMatchObject({
      command: 'conflict',
      file: 'README.md',
      useShared: false,
      useLocal: false,
      resolveFile: 'merged.md',
      json: true,
    });
  });

  it('maps open conflict packages to paused sync state', () => {
    expect(
      syncStateForDaemon(
        { hash: 'sha256:local', conflict: null, historyLoadError: null },
        { relayRoomId: 'relay_1', hostOnline: true },
        { conflict: { status: 'open' } },
      ),
    ).toBe('paused');
  });

  it('posts use-local conflict resolutions with shared revision guards', async () => {
    const { file, realFile, registryPath } = await createRegistryFixture();
    const conflict = {
      conflictId: 'conflict_1',
      status: 'open',
      sharedRevision: 7,
      sharedHash: 'sha256:shared',
      expectedSharedRevision: 6,
      expectedSharedHash: 'sha256:expected-shared',
    };
    let resolutionPayload = null;
    const server = http.createServer(async (request, response) => {
      if (request.url === '/api/local/document') {
        jsonResponse(response, { absolutePath: realFile, hash: 'sha256:local', conflict: null });
        return;
      }
      if (request.url === '/api/local/conflicts/current') {
        jsonResponse(response, { conflict });
        return;
      }
      if (request.url === '/api/local/conflicts/conflict_1/use-local' && request.method === 'POST') {
        resolutionPayload = JSON.parse(await readRequestBody(request));
        jsonResponse(response, {
          conflictId: 'conflict_1',
          status: 'resolved',
          hash: 'sha256:local',
          sharedRevision: 8,
        });
        return;
      }
      jsonResponse(response, { error: 'not_found', url: request.url, method: request.method }, 404);
    });

    try {
      const port = await listen(server);
      await writeDaemonRegistry({
        schemaVersion: 1,
        daemons: [createDaemonEntry({
          realpath: realFile,
          pid: process.pid,
          apiPort: port,
          webPort: 5175,
          apiUrl: `http://127.0.0.1:${port}`,
          webUrl: 'http://127.0.0.1:5175',
          localUrl: 'http://127.0.0.1:5175/local#token=secret',
          token: 'secret',
        })],
      }, registryPath);

      const result = await runMarklab(['conflict', file, '--use-local', '--json'], {
        MARKLAB_LOCAL_DAEMON_REGISTRY_PATH: registryPath,
      });

      expect(result).toMatchObject({ code: 0, stderr: '' });
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        path: realFile,
        syncState: 'synced',
        resolution: {
          conflictId: 'conflict_1',
          status: 'resolved',
          sharedRevision: 8,
        },
      });
      expect(resolutionPayload).toEqual({
        expectedSharedRevision: 6,
        expectedSharedHash: 'sha256:expected-shared',
      });
    } finally {
      await closeServer(server);
    }
  });

  it('returns a stable JSON error for mutually exclusive conflict actions', async () => {
    const result = await runMarklab(['conflict', 'README.md', '--use-local', '--use-shared', '--json'], {});

    expect(result.code).not.toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      code: 'invalid_conflict_action',
      message: 'Choose only one conflict resolution action.',
    });
  });

  it('returns a stable JSON error when --resolve-file has no path', async () => {
    const result = await runMarklab(['conflict', 'README.md', '--resolve-file', '--json'], {});

    expect(result.code).not.toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      code: 'invalid_conflict_action',
      message: 'Provide a Markdown file path after --resolve-file.',
    });
  });

  it('returns a stable JSON error when conflict resolution is rejected', async () => {
    const { file, realFile, registryPath } = await createRegistryFixture();
    const conflict = {
      conflictId: 'conflict_1',
      status: 'open',
      sharedRevision: 7,
      sharedHash: 'sha256:shared',
    };
    const server = http.createServer(async (request, response) => {
      if (request.url === '/api/local/document') {
        jsonResponse(response, { absolutePath: realFile, hash: 'sha256:local', conflict: null });
        return;
      }
      if (request.url === '/api/local/conflicts/current') {
        jsonResponse(response, { conflict });
        return;
      }
      if (request.url === '/api/local/conflicts/conflict_1/use-local' && request.method === 'POST') {
        jsonResponse(response, { error: 'stale_conflict_shared_state' }, 409);
        return;
      }
      jsonResponse(response, { error: 'not_found', url: request.url, method: request.method }, 404);
    });

    try {
      const port = await listen(server);
      await writeDaemonRegistry({
        schemaVersion: 1,
        daemons: [createDaemonEntry({
          realpath: realFile,
          pid: process.pid,
          apiPort: port,
          webPort: 5175,
          apiUrl: `http://127.0.0.1:${port}`,
          webUrl: 'http://127.0.0.1:5175',
          localUrl: 'http://127.0.0.1:5175/local#token=secret',
          token: 'secret',
        })],
      }, registryPath);

      const result = await runMarklab(['conflict', file, '--use-local', '--json'], {
        MARKLAB_LOCAL_DAEMON_REGISTRY_PATH: registryPath,
      });

      expect(result.code).not.toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        code: 'conflict_resolution_failed',
        message: 'Unable to publish the local conflict version.',
        details: {
          path: realFile,
          status: 409,
          body: JSON.stringify({ error: 'stale_conflict_shared_state' }),
        },
      });
    } finally {
      await closeServer(server);
    }
  });

  it('preserves host_offline conflict resolution failures for agents', async () => {
    const { file, realFile, registryPath } = await createRegistryFixture();
    const conflict = {
      conflictId: 'conflict_1',
      status: 'open',
      sharedRevision: 7,
      sharedHash: 'sha256:shared',
    };
    const server = http.createServer(async (request, response) => {
      if (request.url === '/api/local/document') {
        jsonResponse(response, { absolutePath: realFile, hash: 'sha256:local', conflict: null });
        return;
      }
      if (request.url === '/api/local/conflicts/current') {
        jsonResponse(response, { conflict });
        return;
      }
      if (request.url === '/api/local/conflicts/conflict_1/use-local' && request.method === 'POST') {
        jsonResponse(response, { error: 'host_offline' }, 409);
        return;
      }
      jsonResponse(response, { error: 'not_found', url: request.url, method: request.method }, 404);
    });

    try {
      const port = await listen(server);
      await writeDaemonRegistry({
        schemaVersion: 1,
        daemons: [createDaemonEntry({
          realpath: realFile,
          pid: process.pid,
          apiPort: port,
          webPort: 5175,
          apiUrl: `http://127.0.0.1:${port}`,
          webUrl: 'http://127.0.0.1:5175',
          localUrl: 'http://127.0.0.1:5175/local#token=secret',
          token: 'secret',
        })],
      }, registryPath);

      const result = await runMarklab(['conflict', file, '--use-local', '--json'], {
        MARKLAB_LOCAL_DAEMON_REGISTRY_PATH: registryPath,
      });

      expect(result.code).toBe(5);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        code: 'host_offline',
        message: 'The host is offline. Retry when the host returns.',
        details: {
          path: realFile,
          status: 409,
          body: JSON.stringify({ error: 'host_offline' }),
        },
      });
    } finally {
      await closeServer(server);
    }
  });
});
