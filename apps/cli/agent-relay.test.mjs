import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createDaemonEntry, writeDaemonRegistry } from './daemon-supervisor.mjs';
import { parseCliArgs } from './marklab.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function runCli(args, env) {
  const child = spawn(process.execPath, ['apps/cli/marklab.mjs', ...args], {
    cwd: repoRoot,
    env: { ...process.env, MARKLAB_ENABLE_LEGACY_CLI: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr?.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  return new Promise((resolveRun, rejectRun) => {
    child.once('error', rejectRun);
    child.once('exit', (code, signal) => resolveRun({ code, signal, stdout, stderr }));
  });
}

async function readRequestJson(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk.toString();
  return raw ? JSON.parse(raw) : null;
}

async function startRelayServer() {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer local-secret') {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'forbidden' }));
      return;
    }
    if (req.method === 'GET' && req.url === '/api/local/share-state') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        localPath: '/tmp/README.md',
        relayRoomId: 'room_1',
        hostOnline: true,
        hostSessionId: 'host_1',
        sharedRevision: 7,
        lastSharedHash: 'sha256:shared',
        links: [{ grantId: 'grant_1', relayRoomId: 'room_1', role: 'view', activeSessionCount: 2 }],
        sessions: [{ sessionId: 'session_1', grantId: 'grant_1', clientKind: 'browser', displayName: 'Guest 1', role: 'view' }],
      }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/local/access-grants') {
      calls.push(await readRequestJson(req));
      const role = calls.at(-1).role;
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        grantId: 'grant_2',
        relayRoomId: 'room_1',
        role,
        token: 'ml_relay_raw_secret',
        url: `http://127.0.0.1:5175/relay/room_1?token=ml_relay_raw_secret&mode=${role}`,
        expiresAt: null,
        createdAt: '2026-05-01T00:00:00.000Z',
      }));
      return;
    }
    if (req.method === 'DELETE' && req.url === '/api/local/access-grants/grant_1') {
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
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
    apiUrl: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  };
}

async function watchedFile(apiUrl) {
  const directory = await mkdtemp(join(tmpdir(), 'marklab-agent-relay-'));
  const file = join(directory, 'README.md');
  await writeFile(file, '# Relay\n', 'utf8');
  const realFile = await realpath(file);
  const registryPath = join(directory, 'registry.json');
  await writeDaemonRegistry({
    schemaVersion: 1,
    daemons: [
      createDaemonEntry({
        realpath: realFile,
        pid: process.pid,
        apiPort: Number(new URL(apiUrl).port),
        webPort: 5175,
        apiUrl,
        webUrl: 'http://127.0.0.1:5175',
        localUrl: 'http://127.0.0.1:5175/local#token=local-secret',
        token: 'local-secret',
      }),
    ],
  }, registryPath);
  return { file, realFile, registryPath };
}

describe('agent relay commands', () => {
  it('parses share, share-state, create-link, and revoke-link with --json', () => {
    expect(parseCliArgs(['share', 'README.md', '--json'])).toEqual({
      command: 'share',
      file: 'README.md',
      json: true,
      daemonOnly: false,
    });
    expect(parseCliArgs(['share-state', 'README.md', '--json'])).toEqual({
      command: 'share-state',
      file: 'README.md',
      json: true,
    });
    expect(parseCliArgs(['create-link', 'README.md', '--role', 'view', '--json'])).toEqual({
      command: 'create-link',
      file: 'README.md',
      role: 'view',
      json: true,
    });
    expect(parseCliArgs(['revoke-link', 'README.md', 'grant_1', '--json'])).toEqual({
      command: 'revoke-link',
      file: 'README.md',
      grantId: 'grant_1',
      json: true,
    });
  });

  it('parses forbidden hosted/local write commands into the stable forbidden path', () => {
    for (const command of ['write', 'edit', 'hosted-write', 'hosted-edit']) {
      expect(parseCliArgs([command, 'README.md', '--json'])).toEqual({
        command,
        forbiddenAgentWrite: true,
        json: true,
      });
    }
  });

  it('returns stable JSON for share-state, create-link, and revoke-link without exposing share-state token material', async () => {
    const server = await startRelayServer();
    try {
      const file = await watchedFile(server.apiUrl);
      const env = { MARKLAB_LOCAL_DAEMON_REGISTRY_PATH: file.registryPath };

      const shareState = await runCli(['share-state', file.file, '--json'], env);
      expect(shareState).toMatchObject({ code: 0, signal: null, stderr: '' });
      expect(JSON.parse(shareState.stdout)).toMatchObject({
        ok: true,
        path: file.realFile,
        shareState: {
          relayRoomId: 'room_1',
          links: [expect.objectContaining({ role: 'view', activeSessionCount: 2 })],
        },
      });
      expect(shareState.stdout).not.toContain('ml_relay_raw_secret');
      expect(shareState.stdout).not.toContain('token_hash');

      const created = await runCli(['create-link', file.file, '--role', 'edit', '--json'], env);
      expect(JSON.parse(created.stdout)).toMatchObject({
        ok: true,
        path: file.realFile,
        role: 'edit',
        grantId: 'grant_2',
        url: expect.stringContaining('/relay/room_1?'),
      });
      expect(server.calls.at(-1)).toEqual({ role: 'edit' });

      const revoked = await runCli(['revoke-link', file.file, 'grant_1', '--json'], env);
      expect(JSON.parse(revoked.stdout)).toMatchObject({
        ok: true,
        path: file.realFile,
        grantId: 'grant_1',
        revoked: true,
      });
    } finally {
      await server.close();
    }
  });
});
