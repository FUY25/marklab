import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';

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

describe('packed @marklab/cli install smoke', () => {
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
  }, 120000);
});
