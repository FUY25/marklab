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

async function startVersionServer() {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer local-secret') {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'forbidden' }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/local/versions/manual-save') {
      calls.push(await readRequestJson(req));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ created: true, versionId: 'v2', versionNumber: 2, hash: 'sha256:new' }));
      return;
    }
    if (req.method === 'GET' && req.url === '/api/local/versions') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ versions: [{ versionId: 'v2', versionNumber: 2, operation: 'manual_save', hash: 'sha256:new' }] }));
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
  const directory = await mkdtemp(join(tmpdir(), 'marklab-agent-version-'));
  const file = join(directory, 'README.md');
  await writeFile(file, '# Version\n', 'utf8');
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

describe('agent version commands', () => {
  it('parses save-version and versions as JSON-capable agent commands', () => {
    expect(parseCliArgs(['save-version', 'README.md', '--message', 'Before AI edit', '--json'])).toEqual({
      command: 'save-version',
      file: 'README.md',
      message: 'Before AI edit',
      json: true,
    });
    expect(parseCliArgs(['versions', 'README.md', '--json'])).toEqual({
      command: 'versions',
      file: 'README.md',
      json: true,
    });
  });

  it('does not introduce a restore command in the Plan 05 agent contract', () => {
    expect(parseCliArgs(['restore', 'README.md', '--json'])).toEqual({
      command: 'restore',
      json: true,
    });
  });

  it('calls the local manual-save route with agent metadata and keeps versions token-free', async () => {
    const server = await startVersionServer();
    try {
      const file = await watchedFile(server.apiUrl);
      const env = { MARKLAB_LOCAL_DAEMON_REGISTRY_PATH: file.registryPath };

      const saved = await runCli(['save-version', file.file, '--message', 'Before AI edit', '--json'], env);
      expect(saved).toMatchObject({ code: 0, signal: null, stderr: '' });
      expect(JSON.parse(saved.stdout)).toMatchObject({
        ok: true,
        path: file.realFile,
        source: 'agent',
        message: 'Before AI edit',
        versionId: 'v2',
      });
      expect(server.calls[0]).toEqual({ source: 'agent', message: 'Before AI edit' });

      const versions = await runCli(['versions', file.file, '--json'], env);
      expect(JSON.parse(versions.stdout)).toMatchObject({
        ok: true,
        path: file.realFile,
        versions: [expect.objectContaining({ versionId: 'v2', operation: 'manual_save' })],
      });
      expect(versions.stdout).not.toContain('local-secret');
      expect(versions.stdout).not.toContain('#token=');
    } finally {
      await server.close();
    }
  });
});
