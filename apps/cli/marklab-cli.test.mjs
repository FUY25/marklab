import { spawn } from 'node:child_process';
import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildLocalUrls, chooseLocalPorts, choosePort, parseCliArgs } from './marklab.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function listenOnLoopback(port) {
  const server = net.createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

async function freePort() {
  const server = await listenOnLoopback(0);
  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise((resolveClose) => server.close(resolveClose));
    throw new Error('missing_test_port');
  }
  const port = address.port;
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

function runCli(args, env, timeoutMs = 90000) {
  const child = spawn(process.execPath, ['apps/cli/marklab.mjs', ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
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
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      rejectRun(new Error(`marklab ${args.join(' ')} timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, timeoutMs);

    child.once('error', (error) => {
      clearTimeout(timer);
      rejectRun(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolveRun({ code, signal, stdout, stderr });
    });
  });
}

function expectCliOk(result) {
  expect(result, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toMatchObject({
    code: 0,
    signal: null,
  });
}

describe('marklab CLI', () => {
  it('parses foreground, background, status, and stop commands', () => {
    expect(parseCliArgs(['open', 'README.md'])).toEqual({
      command: 'open',
      file: 'README.md',
      background: false,
    });
    expect(parseCliArgs(['open', 'README.md', '--background'])).toEqual({
      command: 'open',
      file: 'README.md',
      background: true,
    });
    expect(parseCliArgs(['status'])).toEqual({ command: 'status' });
    expect(parseCliArgs(['stop', 'README.md'])).toEqual({
      command: 'stop',
      file: 'README.md',
      all: false,
    });
    expect(parseCliArgs(['stop', '--all'])).toEqual({
      command: 'stop',
      file: null,
      all: true,
    });
  });

  it('puts the local daemon token in the local browser URL fragment', () => {
    expect(buildLocalUrls(3011, 5175, 'secret token')).toMatchObject({
      apiUrl: 'http://127.0.0.1:3011',
      webUrl: 'http://127.0.0.1:5175',
      localUrl: 'http://127.0.0.1:5175/local#token=secret%20token',
    });
  });

  it('reports a configured port conflict instead of silently reusing it', async () => {
    const server = await listenOnLoopback(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing_test_port');
    try {
      await expect(choosePort(3011, 'MARKLAB_API_PORT', { MARKLAB_API_PORT: String(address.port) })).rejects.toThrow(
        `MARKLAB_API_PORT=${address.port} is already in use`,
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('rejects identical configured API and web ports', async () => {
    await expect(
      chooseLocalPorts({
        MARKLAB_API_PORT: '49151',
        MARKLAB_WEB_PORT: '49151',
      }),
    ).rejects.toThrow('MARKLAB_API_PORT and MARKLAB_WEB_PORT must be different');
  });

  it('opens and stops a real background daemon for one local Markdown file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'marklab-cli-bg-'));
    const appSupportDirectory = join(directory, 'app-support');
    const markdownPath = join(directory, 'README.md');
    await writeFile(markdownPath, '# Background daemon\n\nInitial body.\n', 'utf8');
    const canonicalMarkdownPath = await realpath(markdownPath);

    const env = {
      MARKLAB_APP_SUPPORT_DIR: appSupportDirectory,
      MARKLAB_NO_OPEN: 'true',
      MARKLAB_API_PORT: String(await freePort()),
      MARKLAB_WEB_PORT: String(await freePort()),
    };

    try {
      const opened = await runCli(['open', markdownPath, '--background'], env);
      expectCliOk(opened);
      expect(opened.stdout).toContain(`Opened ${canonicalMarkdownPath}`);
      expect(opened.stdout).toContain('Browser URL: http://127.0.0.1:');

      const browserUrl = opened.stdout.match(/Browser URL: (http:\/\/127\.0\.0\.1:\d+\/local#token=\S+)/)?.[1];
      expect(browserUrl).toBeTruthy();
      const token = decodeURIComponent(new URL(browserUrl).hash.replace(/^#token=/u, ''));

      const status = await runCli(['status'], env);
      expectCliOk(status);
      expect(status.stdout).toContain(canonicalMarkdownPath);
      expect(status.stdout).toContain('Last sync state: running');

      const documentResponse = await fetch(`http://127.0.0.1:${env.MARKLAB_API_PORT}/api/local/document`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(documentResponse.status).toBe(200);
      await expect(documentResponse.json()).resolves.toMatchObject({
        absolutePath: canonicalMarkdownPath,
      });

      const stopped = await runCli(['stop', markdownPath], env);
      expectCliOk(stopped);
      expect(stopped.stdout).toContain(`Stopped ${canonicalMarkdownPath}`);

      const finalStatus = await runCli(['status'], env);
      expectCliOk(finalStatus);
      expect(finalStatus.stdout).toContain('No MarkLab local daemons are running.');
    } finally {
      await runCli(['stop', '--all'], env, 30000).catch(() => undefined);
    }
  }, 120000);
});
