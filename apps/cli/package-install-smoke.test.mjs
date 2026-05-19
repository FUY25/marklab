import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readlink, readdir, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ensurePackagedRuntimeWorkspaceLinks } from './marklab.mjs';

const cliRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(cliRoot, '../..');

function run(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: { ...process.env, ...(options.env ?? {}) },
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

function expectOk(result) {
  expect(result, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toMatchObject({
    code: 0,
    signal: null,
  });
}

function listenOnLoopback(port = 0) {
  const server = net.createServer();
  return new Promise((resolveServer, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolveServer(server));
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

describe('packed @marklab/cli install smoke', () => {
  it('creates workspace links for the embedded runtime package imports', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'marklab-cli-runtime-'));
    await mkdir(join(runtimeRoot, 'packages', 'shared'), { recursive: true });
    await mkdir(join(runtimeRoot, 'packages', 'markdown'), { recursive: true });
    await mkdir(join(runtimeRoot, 'packages', 'collab-editor'), { recursive: true });

    expect(ensurePackagedRuntimeWorkspaceLinks(runtimeRoot, runtimeRoot)).toBe(true);

    for (const name of ['shared', 'markdown', 'collab-editor']) {
      const linkPath = join(runtimeRoot, 'node_modules', '@marklab', name);
      expect(existsSync(linkPath)).toBe(true);
      expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
      expect(await readlink(linkPath)).toBe(`../../packages/${name}`);
    }
  });

  it('runs help and command help from a clean install without a repo checkout', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'marklab-cli-pack-'));
    const packed = await run('npx', ['-y', 'pnpm@10.0.0', 'pack', '--pack-destination', temp], {
      cwd: cliRoot,
    });
    expectOk(packed);
    const tarballs = (await readdir(temp)).filter((name) => name.endsWith('.tgz'));
    expect(tarballs).toHaveLength(1);

    const installDir = await mkdtemp(join(tmpdir(), 'marklab-cli-install-'));
    const installed = await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(temp, tarballs[0])], {
      cwd: installDir,
    });
    expectOk(installed);

    const bin = process.platform === 'win32'
      ? join(installDir, 'node_modules', '.bin', 'marklab.cmd')
      : join(installDir, 'node_modules', '.bin', 'marklab');
    expect(existsSync(bin)).toBe(true);

    for (const args of [['--help'], ['open', '--help'], ['share', '--help'], ['join', '--help']]) {
      const result = await run(bin, args, { cwd: installDir, env: { MARKLAB_NO_OPEN: 'true' } });
      expectOk(result);
      expect(result.stdout).toContain('Usage:');
    }

    const markdownPath = join(installDir, 'doctor.md');
    await writeFile(markdownPath, '# Doctor\n', 'utf8');
    const npmBinDir = join(installDir, 'node_modules', '.bin');
    const nodeBinDir = dirname(process.execPath);
    const doctor = await run(bin, ['doctor', markdownPath, '--json'], {
      cwd: installDir,
      env: {
        MARKLAB_DOCTOR_SKIP_NETWORK: '1',
        MARKLAB_API_PORT: String(await freePort()),
        MARKLAB_WEB_PORT: String(await freePort()),
        PATH: `${npmBinDir}${delimiter}${nodeBinDir}${delimiter}/usr/bin:/bin`,
      },
    });
    expectOk(doctor);
    const body = JSON.parse(doctor.stdout);
    expect(body.ok).toBe(true);
    expect(body.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'milkdown_headless_runtime',
        status: 'warning',
        message: expect.stringContaining('Skipped'),
      }),
    ]));
  }, 120000);
});
