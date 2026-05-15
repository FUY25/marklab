import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import {
  cleanupStaleRegistryEntries,
  createDaemonEntry,
  readDaemonRegistry,
  registerDaemonEntry,
  stopDaemonEntry,
  writeDaemonRegistry,
} from './daemon-supervisor.mjs';

async function createRegistryPath() {
  const directory = await mkdtemp(join(tmpdir(), 'marklab-daemon-registry-'));
  return join(directory, 'local-daemons.json');
}

function entry(input) {
  return createDaemonEntry({
    realpath: input.realpath ?? '/tmp/README.md',
    pid: input.pid,
    apiPort: input.apiPort ?? 3011,
    webPort: input.webPort ?? 5175,
    apiUrl: input.apiUrl ?? 'http://127.0.0.1:3011',
    webUrl: input.webUrl ?? 'http://127.0.0.1:5175',
    localUrl: input.localUrl ?? 'http://127.0.0.1:5175/local#token=test',
    token: input.token ?? 'test-token',
    ownerKind: input.ownerKind,
  });
}

describe('daemon supervisor registry', () => {
  it('refuses duplicate background daemons for the same canonical realpath', async () => {
    const registryPath = await createRegistryPath();
    const first = entry({ pid: 100 });
    const duplicate = entry({ pid: 101 });
    const isAlive = (pid) => pid === 100 || pid === 101;

    await expect(registerDaemonEntry(first, registryPath, isAlive)).resolves.toMatchObject({ registered: true });
    await expect(registerDaemonEntry(duplicate, registryPath, isAlive)).resolves.toMatchObject({
      registered: false,
      existing: expect.objectContaining({ pid: 100 }),
    });
    await expect(readDaemonRegistry(registryPath)).resolves.toMatchObject({
      daemons: [expect.objectContaining({ pid: 100 })],
    });
  });

  it('records whether the daemon is owned by the CLI or native app', () => {
    expect(entry({ pid: 100 })).toMatchObject({ ownerKind: 'cli' });
    expect(entry({ pid: 101, ownerKind: 'app' })).toMatchObject({ ownerKind: 'app' });
  });

  it('cleans stale registry entries when their process is gone', async () => {
    const registryPath = await createRegistryPath();
    await writeDaemonRegistry(
      {
        schemaVersion: 1,
        daemons: [entry({ pid: 100 }), entry({ pid: 101, realpath: '/tmp/other.md' })],
      },
      registryPath,
    );

    await expect(cleanupStaleRegistryEntries(registryPath, (pid) => pid === 101)).resolves.toMatchObject({
      removed: 1,
      daemons: [expect.objectContaining({ pid: 101 })],
    });
  });

  it('leaves a dirty daemon running when graceful shutdown flush fails', async () => {
    const registryPath = await createRegistryPath();
    const daemon = entry({ pid: 100 });
    await writeDaemonRegistry({ schemaVersion: 1, daemons: [daemon] }, registryPath);

    const result = await stopDaemonEntry(daemon, {
      registryPath,
      isAlive: () => true,
      fetchImpl: async () => ({
        ok: false,
        status: 409,
        text: async () => '{"error":"active_collab_flush_failed"}',
      }),
    });

    expect(result).toMatchObject({ stopped: false, reason: 'flush_failed' });
    await expect(readDaemonRegistry(registryPath)).resolves.toMatchObject({
      daemons: [expect.objectContaining({ pid: 100 })],
    });
  });

  it('removes the registry entry after successful graceful stop so no daemon is orphaned', async () => {
    const registryPath = await createRegistryPath();
    const daemon = entry({ pid: 100 });
    const running = new Set([100]);
    await writeDaemonRegistry({ schemaVersion: 1, daemons: [daemon] }, registryPath);

    const result = await stopDaemonEntry(daemon, {
      registryPath,
      isAlive: (pid) => running.has(pid),
      fetchImpl: async () => {
        running.delete(100);
        return {
          ok: true,
          text: async () => '{"ok":true}',
        };
      },
    });

    expect(result).toMatchObject({ stopped: true });
    await expect(readDaemonRegistry(registryPath)).resolves.toMatchObject({ daemons: [] });
  });

  it('removes the registry entry when process-group SIGTERM stops a daemon after graceful shutdown', async () => {
    vi.useFakeTimers();
    try {
      const registryPath = await createRegistryPath();
      const daemon = entry({ pid: 100 });
      const running = new Set([100]);
      await writeDaemonRegistry({ schemaVersion: 1, daemons: [daemon] }, registryPath);

      const resultPromise = stopDaemonEntry(daemon, {
        registryPath,
        timeoutMs: 0,
        isAlive: (pid) => running.has(pid),
        signalProcessTree: (pid, signal) => {
          expect(pid).toBe(100);
          expect(signal).toBe('SIGTERM');
          running.delete(pid);
          return true;
        },
        fetchImpl: async () => ({
          ok: true,
          text: async () => '{"ok":true}',
        }),
      });

      await vi.runAllTimersAsync();
      await expect(resultPromise).resolves.toMatchObject({ stopped: true });
      await expect(readDaemonRegistry(registryPath)).resolves.toMatchObject({ daemons: [] });
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves the registry entry when the daemon survives graceful shutdown and process-group SIGTERM', async () => {
    vi.useFakeTimers();
    try {
      const registryPath = await createRegistryPath();
      const daemon = entry({ pid: 100 });
      await writeDaemonRegistry({ schemaVersion: 1, daemons: [daemon] }, registryPath);
      const signalProcessTree = vi.fn(() => true);

      const resultPromise = stopDaemonEntry(daemon, {
        registryPath,
        timeoutMs: 0,
        isAlive: () => true,
        signalProcessTree,
        fetchImpl: async () => ({
          ok: true,
          text: async () => '{"ok":true}',
        }),
      });

      await vi.runAllTimersAsync();
      await expect(resultPromise).resolves.toMatchObject({ stopped: false, reason: 'process_still_running' });
      expect(signalProcessTree).toHaveBeenCalledWith(100, 'SIGTERM');
      await expect(readDaemonRegistry(registryPath)).resolves.toMatchObject({
        daemons: [expect.objectContaining({ pid: 100 })],
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
