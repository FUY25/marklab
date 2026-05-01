import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { DbPool } from '../db/client';
import { createHttpApp } from '../http/app';
import type { LocalFileService } from '../local/local-file-service';
import { createUnavailableLiveMarkdownWriter } from '../services/live-writer';
import { isLoopbackLocalRequest } from './local-file-routes';

function createLocalOnlyPool(): DbPool {
  async function unavailable(): Promise<never> {
    throw new Error('database_not_configured');
  }

  return {
    query: unavailable,
    connect: unavailable,
  };
}

function createFakeLocalFileService(): LocalFileService {
  return {
    roomName: 'local:file:test',
    canHandleRoom: (roomName) => roomName === 'local:file:test',
    loadRoomState: vi.fn(async () => null),
    storeRoomState: vi.fn(async () => ({ stored: true, stateFingerprint: 'state' })),
    getSummary: () => ({
      localDocId: 'test',
      displayName: 'README.md',
      absolutePath: '/tmp/README.md',
      roomName: 'local:file:test',
      hash: 'sha256:test',
      conflict: null,
      historyLoadError: null,
    }),
    listVersions: () => [],
    getVersion: () => {
      throw new Error('local_version_not_found');
    },
    createManualVersion: vi.fn(async () => ({
      created: true,
      versionId: 'test-v1',
      versionNumber: 1,
      hash: 'sha256:test',
    })),
    restoreVersion: vi.fn(async () => ({
      versionId: 'test-v1',
      versionNumber: 1,
      hash: 'sha256:test',
      yjsState: new Uint8Array([1, 2, 3]),
    })),
    startWatcher: vi.fn(),
    stopWatcher: vi.fn(),
  };
}

describe('local file routes', () => {
  it('uses loopback host and origin checks for local collab websocket upgrades', () => {
    expect(isLoopbackLocalRequest({ host: '127.0.0.1:3001', origin: 'http://localhost:5173' })).toBe(true);
    expect(isLoopbackLocalRequest({ host: '[::1]:3001', origin: 'http://[::1]:5173' })).toBe(true);

    expect(isLoopbackLocalRequest({ host: 'evil.example', origin: 'http://localhost:5173' })).toBe(false);
    expect(isLoopbackLocalRequest({ host: '127.0.0.1:3001', origin: 'https://evil.example' })).toBe(false);
  });

  it('requires the local daemon token for local file reads', async () => {
    const service = createFakeLocalFileService();
    const app = createHttpApp(createLocalOnlyPool(), createUnavailableLiveMarkdownWriter(), {
      localFileService: service,
      localDaemonToken: 'local-secret',
      localMode: true,
    });

    await request(app).get('/api/local/document').expect(403);

    const response = await request(app)
      .get('/api/local/document')
      .set('Authorization', 'Bearer local-secret')
      .expect(200);
    expect(response.body).toMatchObject({
      localDocId: 'test',
      absolutePath: '/tmp/README.md',
      roomName: 'local:file:test',
    });
  });

  it('does not flush or mutate local files without the local daemon token', async () => {
    const service = createFakeLocalFileService();
    const flushCollabDocument = vi.fn(async () => undefined);
    const app = createHttpApp(createLocalOnlyPool(), createUnavailableLiveMarkdownWriter(), {
      localFileService: service,
      localDaemonToken: 'local-secret',
      localMode: true,
      flushCollabDocument,
    });

    await request(app).post('/api/local/flush').expect(403);
    expect(flushCollabDocument).not.toHaveBeenCalled();

    await request(app).post('/api/local/flush').set('Authorization', 'Bearer local-secret').expect(200);
    expect(flushCollabDocument).toHaveBeenCalledWith('local:file:test');
  });

  it('does not mount cloud document or hosted AI write routes in local mode', async () => {
    const service = createFakeLocalFileService();
    const app = createHttpApp(createLocalOnlyPool(), createUnavailableLiveMarkdownWriter(), {
      localFileService: service,
      localDaemonToken: 'local-secret',
      localMode: true,
    });

    await request(app).get('/api/docs').expect(404);
    await request(app).post('/api/docs/import').send({ title: 'x', markdown: '# x\n' }).expect(404);
    await request(app)
      .post('/api/docs/doc_001/branches/br_main/write')
      .send({ baseVersionId: 'v1', baseHash: 'sha256:x', markdown: '# x\n' })
      .expect(404);
    await request(app)
      .post('/api/docs/doc_001/branches/br_main/edit')
      .send({ oldString: 'x', newString: 'y', replaceAll: false })
      .expect(404);
  });
});
