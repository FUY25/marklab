import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { createJsonLocalMetadataStore } from './local-metadata-store';

async function createMetadataPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'marklab-local-metadata-'));
  return join(directory, 'marklab-local.json');
}

describe('JsonLocalMetadataStore', () => {
  it('persists local document metadata and versions with a caller-provided path', async () => {
    const metadataPath = await createMetadataPath();
    const store = createJsonLocalMetadataStore(metadataPath);

    await store.saveDocument({
      schemaVersion: 1,
      localDocId: 'doc_local',
      absolutePath: '/tmp/local.md',
      displayName: 'local.md',
      roomName: 'local:file:doc_local',
      lastDiskHash: 'sha256:disk',
      currentHash: 'sha256:current',
      currentYjsStateBase64: Buffer.from([1, 2, 3]).toString('base64'),
      updatedAt: '2026-05-01T00:00:00.000Z',
    });
    await store.appendVersion({
      schemaVersion: 1,
      versionId: 'doc_local-v1',
      localDocId: 'doc_local',
      versionNumber: 1,
      operation: 'manual_save',
      markdownSnapshot: '# Saved\n',
      yjsStateBase64: Buffer.from([4, 5, 6]).toString('base64'),
      hash: 'sha256:saved',
      createdAt: '2026-05-01T00:00:00.000Z',
    });

    const reloaded = createJsonLocalMetadataStore(metadataPath);
    await expect(reloaded.loadDocument('/tmp/local.md')).resolves.toMatchObject({
      localDocId: 'doc_local',
      currentHash: 'sha256:current',
    });
    await expect(reloaded.listVersions('doc_local')).resolves.toEqual([
      expect.objectContaining({
        versionId: 'doc_local-v1',
        markdownSnapshot: '# Saved\n',
      }),
    ]);

    const raw = await readFile(metadataPath, 'utf8');
    expect(JSON.parse(raw)).toMatchObject({ schemaVersion: 1 });
  });

  it('treats corrupt metadata as empty so opening a Markdown file is not blocked', async () => {
    const metadataPath = await createMetadataPath();
    await writeFile(metadataPath, '{not valid json', 'utf8');
    const store = createJsonLocalMetadataStore(metadataPath);

    await expect(store.loadDocument('/tmp/local.md')).resolves.toBeNull();
    expect(store.getLastLoadError?.()).toBe('corrupt_metadata');
    await expect(store.listVersions('doc_local')).resolves.toEqual([]);

    await store.appendVersion({
      schemaVersion: 1,
      versionId: 'doc_local-v1',
      localDocId: 'doc_local',
      versionNumber: 1,
      operation: 'open',
      markdownSnapshot: '# Recovered\n',
      yjsStateBase64: Buffer.from([1]).toString('base64'),
      hash: 'sha256:recovered',
      createdAt: '2026-05-01T00:00:00.000Z',
    });

    const raw = await readFile(metadataPath, 'utf8');
    expect(JSON.parse(raw).versions).toHaveLength(1);
  });

  it('persists local relay join state without token material', async () => {
    const metadataPath = await createMetadataPath();
    const store = createJsonLocalMetadataStore(metadataPath);

    await store.saveRelayJoin({
      schemaVersion: 1,
      relayRoomId: 'relay_room_1',
      grantId: 'grant_1',
      sessionId: 'session_1',
      localDocId: 'doc_local',
      absolutePath: '/tmp/local.md',
      lastAcceptedLocalHash: 'sha256:local',
      lastAcceptedSharedHash: 'sha256:shared',
      lastAcceptedSharedRevision: 4,
      lastHostSessionId: 'host_1',
      disconnectedCleanly: true,
      updatedAt: '2026-05-01T00:00:00.000Z',
    });

    const reloaded = createJsonLocalMetadataStore(metadataPath);
    await expect(reloaded.loadRelayJoin('/tmp/local.md')).resolves.toMatchObject({
      relayRoomId: 'relay_room_1',
      grantId: 'grant_1',
      lastAcceptedSharedRevision: 4,
    });

    const raw = await readFile(metadataPath, 'utf8');
    expect(raw).not.toContain('ml_relay_');
    expect(raw).not.toContain('token_hash');
  });

  it('persists local relay host state so an existing share can resume after daemon restart', async () => {
    const metadataPath = await createMetadataPath();
    const store = createJsonLocalMetadataStore(metadataPath);

    await store.saveRelayHost({
      schemaVersion: 1,
      relayRoomId: 'relay_room_1',
      hostAuthToken: 'ml_relay_host_secret',
      localDocId: 'doc_local',
      absolutePath: '/tmp/local.md',
      lastHostSessionId: 'host_1',
      lastPublishedHash: 'sha256:shared',
      updatedAt: '2026-05-01T00:00:00.000Z',
    });

    const reloaded = createJsonLocalMetadataStore(metadataPath);
    await expect(reloaded.loadRelayHost('/tmp/local.md')).resolves.toMatchObject({
      relayRoomId: 'relay_room_1',
      hostAuthToken: 'ml_relay_host_secret',
      lastHostSessionId: 'host_1',
    });
  });

  it('preserves updates from two store instances writing the same metadata path concurrently', async () => {
    const metadataPath = await createMetadataPath();
    const firstStore = createJsonLocalMetadataStore(metadataPath);
    const secondStore = createJsonLocalMetadataStore(metadataPath);

    await Promise.all([
      firstStore.saveDocument({
        schemaVersion: 1,
        localDocId: 'doc_first',
        absolutePath: '/tmp/first.md',
        displayName: 'first.md',
        roomName: 'local:file:doc_first',
        lastDiskHash: 'sha256:first-disk',
        currentHash: 'sha256:first-current',
        currentYjsStateBase64: Buffer.from([1]).toString('base64'),
        updatedAt: '2026-05-01T00:00:00.000Z',
      }),
      secondStore.saveDocument({
        schemaVersion: 1,
        localDocId: 'doc_second',
        absolutePath: '/tmp/second.md',
        displayName: 'second.md',
        roomName: 'local:file:doc_second',
        lastDiskHash: 'sha256:second-disk',
        currentHash: 'sha256:second-current',
        currentYjsStateBase64: Buffer.from([2]).toString('base64'),
        updatedAt: '2026-05-01T00:00:01.000Z',
      }),
    ]);

    await Promise.all([
      firstStore.appendVersion({
        schemaVersion: 1,
        versionId: 'doc_first-v1',
        localDocId: 'doc_first',
        versionNumber: 1,
        operation: 'manual_save',
        markdownSnapshot: '# First\n',
        yjsStateBase64: Buffer.from([3]).toString('base64'),
        hash: 'sha256:first-version',
        createdAt: '2026-05-01T00:00:02.000Z',
      }),
      secondStore.appendVersion({
        schemaVersion: 1,
        versionId: 'doc_second-v1',
        localDocId: 'doc_second',
        versionNumber: 1,
        operation: 'manual_save',
        markdownSnapshot: '# Second\n',
        yjsStateBase64: Buffer.from([4]).toString('base64'),
        hash: 'sha256:second-version',
        createdAt: '2026-05-01T00:00:03.000Z',
      }),
    ]);

    const reloaded = createJsonLocalMetadataStore(metadataPath);
    await expect(reloaded.loadDocument('/tmp/first.md')).resolves.toMatchObject({ localDocId: 'doc_first' });
    await expect(reloaded.loadDocument('/tmp/second.md')).resolves.toMatchObject({ localDocId: 'doc_second' });
    await expect(reloaded.listVersions('doc_first')).resolves.toEqual([
      expect.objectContaining({ versionId: 'doc_first-v1' }),
    ]);
    await expect(reloaded.listVersions('doc_second')).resolves.toEqual([
      expect.objectContaining({ versionId: 'doc_second-v1' }),
    ]);
  });
});
