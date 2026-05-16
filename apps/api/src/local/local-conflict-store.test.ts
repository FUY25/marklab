import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { createJsonLocalConflictStore, type ReconnectConflict } from './local-conflict-store';

async function createMetadataPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'marklab-local-conflicts-'));
  return join(directory, 'marklab-local.json');
}

function createConflict(overrides: Partial<ReconnectConflict> = {}): ReconnectConflict {
  return {
    conflictId: 'conflict_1',
    relayRoomId: 'relay_1',
    localDocId: 'doc_local',
    localPath: '/tmp/local.md',
    baseMarkdown: '# Base\n',
    baseYjsStateBase64: Buffer.from([1, 2, 3]).toString('base64'),
    baseHash: 'sha256:base',
    lastProjectedMarkdown: '# Base\n',
    lastProjectedHash: 'sha256:base',
    localMarkdown: '# Local\n',
    localYjsStateBase64: Buffer.from([4, 5, 6]).toString('base64'),
    localHash: 'sha256:local',
    sharedMarkdown: '# Shared\n',
    sharedYjsStateBase64: Buffer.from([7, 8, 9]).toString('base64'),
    sharedHash: 'sha256:shared',
    expectedSharedRevision: 4,
    expectedSharedHash: 'sha256:shared',
    sharedStateFingerprint: 'state:shared',
    sharedRevision: 4,
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
    status: 'open',
    ...overrides,
  };
}

describe('JsonLocalConflictStore', () => {
  it('persists open conflict packages across store reloads', async () => {
    const metadataPath = await createMetadataPath();
    const store = createJsonLocalConflictStore(metadataPath);
    const conflict = createConflict();

    await store.saveConflict(conflict);

    const reloaded = createJsonLocalConflictStore(metadataPath);
    await expect(reloaded.loadConflict('conflict_1')).resolves.toEqual(conflict);
    await expect(reloaded.loadCurrentConflict('/tmp/local.md')).resolves.toEqual(conflict);
  });
});
