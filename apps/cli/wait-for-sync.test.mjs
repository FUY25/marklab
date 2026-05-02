import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { createDaemonEntry, writeDaemonRegistry } from './daemon-supervisor.mjs';
import { markdownHash } from './recent-files.mjs';
import { waitForSync } from './wait-for-sync.mjs';

async function createWaitFixture(markdown = '# Wait\n') {
  const directory = await mkdtemp(join(tmpdir(), 'marklab-agent-wait-'));
  const file = join(directory, 'README.md');
  await writeFile(file, markdown, 'utf8');
  const realFile = await realpath(file);
  const registryPath = join(directory, 'registry.json');
  const entry = createDaemonEntry({
    realpath: realFile,
    pid: 23456,
    apiPort: 3011,
    webPort: 5175,
    apiUrl: 'http://127.0.0.1:3011',
    webUrl: 'http://127.0.0.1:5175',
    localUrl: 'http://127.0.0.1:5175/local#token=secret',
    token: 'secret',
  });
  await writeDaemonRegistry({ schemaVersion: 1, daemons: [entry] }, registryPath);
  return { file, realFile, registryPath, hash: markdownHash(markdown) };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('wait for sync', () => {
  it('returns synced once daemon-observed hash matches disk hash', async () => {
    const { file, realFile, registryPath, hash } = await createWaitFixture();
    const fetchImpl = async (url) => {
      if (url.endsWith('/api/local/document')) {
        return jsonResponse({ absolutePath: realFile, displayName: 'README.md', hash, conflict: null });
      }
      if (url.endsWith('/api/local/conflicts/current')) return jsonResponse({ conflict: null });
      if (url.endsWith('/api/local/share-state')) return jsonResponse({ relayRoomId: null, sharedRevision: null });
      if (url.endsWith('/api/local/versions')) return jsonResponse({ versions: [{ versionId: 'v1', hash }] });
      return jsonResponse({ error: 'not_found' }, 404);
    };

    const result = await waitForSync(
      { file, synced: true, timeoutMs: 1000 },
      { registryPath, isAlive: () => true, fetchImpl, intervalMs: 10 },
    );

    expect(result).toMatchObject({
      ok: true,
      path: realFile,
      syncState: 'synced',
      observedHash: hash,
      versionId: 'v1',
      relayRevision: null,
    });
  });

  it('returns sync_paused immediately when a conflict is open', async () => {
    const { file, realFile, registryPath, hash } = await createWaitFixture();
    const fetchImpl = async (url) => {
      if (url.endsWith('/api/local/document')) return jsonResponse({ absolutePath: realFile, hash, conflict: null });
      if (url.endsWith('/api/local/conflicts/current')) return jsonResponse({ conflict: { status: 'open' } });
      return jsonResponse({ error: 'not_found' }, 404);
    };

    await expect(
      waitForSync({ file, synced: true, timeoutMs: 1000 }, { registryPath, isAlive: () => true, fetchImpl, intervalMs: 10 }),
    ).rejects.toMatchObject({
      code: 'sync_paused',
    });
  });

  it('returns host_offline immediately for relay states that cannot sync', async () => {
    const { file, realFile, registryPath, hash } = await createWaitFixture();
    const fetchImpl = async (url) => {
      if (url.endsWith('/api/local/document')) return jsonResponse({ absolutePath: realFile, hash, conflict: null });
      if (url.endsWith('/api/local/conflicts/current')) return jsonResponse({ conflict: null });
      if (url.endsWith('/api/local/share-state')) return jsonResponse({ relayRoomId: 'relay_1', hostOnline: false });
      return jsonResponse({ error: 'not_found' }, 404);
    };

    await expect(
      waitForSync({ file, synced: true, timeoutMs: 1000 }, { registryPath, isAlive: () => true, fetchImpl, intervalMs: 10 }),
    ).rejects.toMatchObject({
      code: 'host_offline',
      exitCode: 5,
    });
  });

  it('times out without mutating the file when daemon-observed hash never catches up', async () => {
    const { file, realFile, registryPath } = await createWaitFixture('# Timeout\n');
    const fetchImpl = async (url) => {
      if (url.endsWith('/api/local/document')) return jsonResponse({ absolutePath: realFile, hash: 'sha256:stale', conflict: null });
      if (url.endsWith('/api/local/conflicts/current')) return jsonResponse({ conflict: null });
      if (url.endsWith('/api/local/share-state')) return jsonResponse({ relayRoomId: null, sharedRevision: null });
      return jsonResponse({ error: 'not_found' }, 404);
    };

    await expect(
      waitForSync({ file, synced: true, timeoutMs: 0 }, { registryPath, isAlive: () => true, fetchImpl, intervalMs: 10 }),
    ).rejects.toMatchObject({
      code: 'sync_timeout',
      exitCode: 6,
    });
  });
});
