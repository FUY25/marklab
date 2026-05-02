import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { createDaemonEntry, writeDaemonRegistry } from './daemon-supervisor.mjs';
import { buildAgentStatus, markdownHash } from './recent-files.mjs';

async function createRegistryFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'marklab-agent-status-'));
  const file = join(directory, 'README.md');
  await writeFile(file, '# Status\n', 'utf8');
  const realFile = await realpath(file);
  const registryPath = join(directory, 'registry.json');
  const entry = createDaemonEntry({
    realpath: realFile,
    pid: 12345,
    apiPort: 3011,
    webPort: 5175,
    apiUrl: 'http://127.0.0.1:3011',
    webUrl: 'http://127.0.0.1:5175',
    localUrl: 'http://127.0.0.1:5175/local#token=secret',
    token: 'secret',
  });
  await writeDaemonRegistry({ schemaVersion: 1, daemons: [entry] }, registryPath);
  return { file, realFile, registryPath, entry };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('agent status', () => {
  it('returns the stable AgentStatusResponse shape without exposing daemon tokens', async () => {
    const { file, realFile, registryPath } = await createRegistryFixture();
    const hash = markdownHash('# Status\n');
    const fetchImpl = async (url) => {
      if (url.endsWith('/api/local/document')) {
        return jsonResponse({
          localDocId: 'doc_1',
          displayName: 'README.md',
          absolutePath: realFile,
          roomName: 'local:file:doc_1',
          hash,
          conflict: null,
          historyLoadError: null,
        });
      }
      if (url.endsWith('/api/local/share-state')) {
        return jsonResponse({ relayRoomId: null, hostOnline: false, sharedRevision: null });
      }
      if (url.endsWith('/api/local/conflicts/current')) return jsonResponse({ conflict: null });
      return jsonResponse({ error: 'not_found' }, 404);
    };

    const result = await buildAgentStatus({ file }, { registryPath, isAlive: () => true, fetchImpl });

    expect(result).toEqual({
      ok: true,
      files: [
        expect.objectContaining({
          path: realFile,
          displayName: 'README.md',
          daemon: 'running',
          mode: 'local',
          syncState: 'synced',
          browserUrl: 'http://127.0.0.1:5175/local#token=secret',
          pid: 12345,
          port: 3011,
          hasConflict: false,
          relayRoomId: null,
        }),
      ],
    });
    expect(JSON.stringify(result)).not.toContain('"token"');
  });

  it('reports paused when the conflict endpoint returns an open conflict package', async () => {
    const { file, realFile, registryPath } = await createRegistryFixture();
    const fetchImpl = async (url) => {
      if (url.endsWith('/api/local/document')) {
        return jsonResponse({
          displayName: 'README.md',
          absolutePath: realFile,
          hash: markdownHash('# Status\n'),
          conflict: null,
          historyLoadError: null,
        });
      }
      if (url.endsWith('/api/local/share-state')) return jsonResponse({ relayRoomId: 'relay_1', hostOnline: true });
      if (url.endsWith('/api/local/conflicts/current')) return jsonResponse({ conflict: { status: 'open' } });
      return jsonResponse({ error: 'not_found' }, 404);
    };

    const result = await buildAgentStatus({ file }, { registryPath, isAlive: () => true, fetchImpl });

    expect(result.files[0]).toMatchObject({
      syncState: 'paused',
      hasConflict: true,
      relayRoomId: 'relay_1',
    });
  });

  it('preserves relay mirror mode and reports host_offline for an offline mirror', async () => {
    const { file, realFile, registryPath } = await createRegistryFixture();
    const fetchImpl = async (url) => {
      if (url.endsWith('/api/local/document')) {
        return jsonResponse({
          displayName: 'README.md',
          absolutePath: realFile,
          hash: markdownHash('# Status\n'),
          conflict: null,
          historyLoadError: null,
        });
      }
      if (url.endsWith('/api/local/share-state')) {
        return jsonResponse({
          mode: 'relay-mirror',
          relayRoomId: 'relay_1',
          hostOnline: false,
          sharedRevision: 4,
        });
      }
      if (url.endsWith('/api/local/conflicts/current')) return jsonResponse({ conflict: null });
      return jsonResponse({ error: 'not_found' }, 404);
    };

    const result = await buildAgentStatus({ file }, { registryPath, isAlive: () => true, fetchImpl });

    expect(result.files[0]).toMatchObject({
      path: realFile,
      mode: 'relay-mirror',
      syncState: 'host_offline',
      relayRoomId: 'relay_1',
      hasConflict: false,
    });
  });
});
