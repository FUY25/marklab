import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runDoctor } from './doctor.mjs';

const successfulMilkdownProbe = async () => ({
  ok: true,
  details: {
    markdownLength: 31,
    yjsStateBytes: 128,
    hash: 'sha256:doctor',
  },
});

function listenOnLoopback(port = 0) {
  const server = net.createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

async function freePort() {
  const server = await listenOnLoopback(0);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing_port');
  const port = address.port;
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
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
          MARKLAB_API_PORT: String(await freePort()),
          MARKLAB_WEB_PORT: String(await freePort()),
        },
        milkdownRuntimeProbe: successfulMilkdownProbe,
      },
    );

    expect(result.ok).toBe(true);
    expect(Array.isArray(result.errors)).toBe(true);
    expect(Array.isArray(result.warnings)).toBe(true);
    expect(result.checks.map((check) => check.name)).toEqual(expect.arrayContaining([
      'node_version',
      'installation_mode',
      'loopback_bind',
      'port_configuration',
      'target_file_permissions',
      'watcher_temp_change',
      'milkdown_headless_runtime',
      'relay_reachability',
    ]));
    await expect(readFile(filePath, 'utf8')).resolves.toBe(before);
  });

  it('fails with doctor_failed when configured ports conflict', async () => {
    const server = await listenOnLoopback(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing_port');
    try {
      await expect(
        runDoctor({}, {
          env: {
            MARKLAB_API_PORT: String(address.port),
            MARKLAB_WEB_PORT: String(await freePort()),
          },
          milkdownRuntimeProbe: successfulMilkdownProbe,
        }),
      ).rejects.toMatchObject({
        code: 'doctor_failed',
        exitCode: 7,
        details: {
          errors: [expect.objectContaining({ code: 'port_conflict' })],
        },
      });
    } finally {
      await new Promise((resolveClose) => server.close(resolveClose));
    }
  });

  it('fails doctor when the Milkdown headless runtime cannot initialize', async () => {
    await expect(
      runDoctor(
        {},
        {
          env: {
            MARKLAB_API_PORT: String(await freePort()),
            MARKLAB_WEB_PORT: String(await freePort()),
          },
          milkdownRuntimeProbe: async () => ({
            ok: false,
            details: {
              reason: 'empty_yjs_state',
            },
          }),
        },
      ),
    ).rejects.toMatchObject({
      code: 'doctor_failed',
      exitCode: 7,
      details: {
        errors: [expect.objectContaining({ code: 'milkdown_headless_init_failed' })],
      },
    });
  });
});
