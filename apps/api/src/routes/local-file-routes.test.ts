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
    getRelayHostState: () => null,
    saveRelayHostState: vi.fn(async () => undefined),
    clearRelayHostState: vi.fn(async () => undefined),
    getRelayJoinState: () => null,
    saveRelayJoinState: vi.fn(async () => undefined),
    pauseForRelayConflict: vi.fn(async () => undefined),
    getCurrentConflict: () => null,
    getConflict: vi.fn(async () => null),
    openReconnectConflict: vi.fn(async () => {
      throw new Error('unexpected_conflict_open');
    }),
    prepareUseSharedConflict: vi.fn(async () => {
      throw new Error('unexpected_conflict_resolution');
    }),
    prepareUseLocalConflict: vi.fn(async () => {
      throw new Error('unexpected_conflict_resolution');
    }),
    prepareResolvedConflict: vi.fn(async () => {
      throw new Error('unexpected_conflict_resolution');
    }),
    preflightConflictResolutionLocalCommit: vi.fn(async () => {
      throw new Error('unexpected_conflict_resolution');
    }),
    commitConflictResolutionLocally: vi.fn(async () => {
      throw new Error('unexpected_conflict_resolution');
    }),
    adoptAppliedConflictResolutionState: vi.fn(async () => {
      throw new Error('unexpected_conflict_resolution');
    }),
    refreshOpenConflictFromDisk: vi.fn(async () => {
      throw new Error('unexpected_conflict_resolution');
    }),
    refreshOpenConflictAfterSharedPublish: vi.fn(async () => {
      throw new Error('unexpected_conflict_resolution');
    }),
    completeConflictResolution: vi.fn(async () => {
      throw new Error('unexpected_conflict_resolution');
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
      source: 'user' as const,
      message: null,
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

  it('reports relay mirror share state when the local daemon joined a relay room', async () => {
    const service = createFakeLocalFileService();
    const shareState = vi.fn(async () => ({
      mode: 'relay-mirror' as const,
      localPath: '/tmp/README.md',
      relayRoomId: 'relay-room-1',
      hostOnline: false,
      hostSessionId: 'host-1',
      sharedRevision: 3,
      lastSharedHash: 'sha256:shared',
      links: [],
      sessions: [],
    }));
    const app = createHttpApp(createLocalOnlyPool(), createUnavailableLiveMarkdownWriter(), {
      localFileService: service,
      localDaemonToken: 'local-secret',
      localMode: true,
      localRelayMirror: {
        start: vi.fn(async () => undefined),
        stop: vi.fn(),
        shareState,
        verifySharedState: vi.fn(async () => undefined),
        publishResolvedState: vi.fn(async () => ({
          sharedRevision: 4,
          sharedHash: 'sha256:shared',
          hostSessionId: 'host-1',
        })),
      },
    });

    const response = await request(app)
      .get('/api/local/share-state')
      .set('Authorization', 'Bearer local-secret')
      .expect(200);

    expect(response.body).toMatchObject({
      mode: 'relay-mirror',
      relayRoomId: 'relay-room-1',
      hostOnline: false,
      sharedRevision: 3,
    });
    expect(shareState).toHaveBeenCalledOnce();
  });

  it('returns one native app context with summary, versions, conflict, and share state', async () => {
    const service = createFakeLocalFileService();
    const shareState = vi.fn(async () => ({
      mode: 'relay-host' as const,
      localPath: '/tmp/README.md',
      relayRoomId: 'relay-room-1',
      hostOnline: true,
      hostSessionId: 'host-1',
      sharedRevision: 7,
      lastSharedHash: 'sha256:shared',
      links: [{
        grantId: 'grant_edit',
        relayRoomId: 'relay-room-1',
        role: 'edit' as const,
        label: null,
        canCopyExistingUrl: false,
        revokedAt: null,
        expiresAt: null,
        createdAt: '2026-05-15T12:00:00.000Z',
        activeSessionCount: 1,
        lastCopiedAt: null,
      }],
      sessions: [{
        sessionId: 'session_browser',
        grantId: 'grant_edit',
        clientKind: 'browser' as const,
        displayName: 'Browser',
        role: 'edit' as const,
        lastSeenAt: '2026-05-15T12:01:00.000Z',
      }],
    }));
    const app = createHttpApp(createLocalOnlyPool(), createUnavailableLiveMarkdownWriter(), {
      localFileService: service,
      localDaemonToken: 'local-secret',
      localMode: true,
      localRelayHost: {
        relayRoomId: 'relay-room-1',
        resumeHosted: vi.fn(async () => true),
        ensureHosted: vi.fn(async () => ({ relayRoomId: 'relay-room-1', hostSessionId: 'host-1' })),
        start: vi.fn(async () => undefined),
        stop: vi.fn(),
        createLink: vi.fn(async () => {
          throw new Error('unexpected_create_link');
        }),
        revokeLink: vi.fn(async () => undefined),
        shareState,
        verifySharedState: vi.fn(async () => undefined),
        publishResolvedState: vi.fn(async () => ({
          sharedRevision: 8,
          sharedHash: 'sha256:shared',
          hostSessionId: 'host-1',
        })),
      },
    });

    const response = await request(app)
      .get('/api/local/app-context')
      .set('Authorization', 'Bearer local-secret')
      .expect(200);

    expect(response.body).toMatchObject({
      document: {
        absolutePath: '/tmp/README.md',
        roomName: 'local:file:test',
        conflict: null,
      },
      versions: [],
      conflict: null,
      shareState: {
        relayRoomId: 'relay-room-1',
        hostOnline: true,
        sharedRevision: 7,
        links: [expect.objectContaining({ grantId: 'grant_edit', role: 'edit' })],
      },
    });
    expect(shareState).toHaveBeenCalledOnce();
  });

  it('starts local sharing for native app actions through the relay host controller', async () => {
    const service = createFakeLocalFileService();
    const ensureHosted = vi.fn(async () => ({ relayRoomId: 'relay-room-1', hostSessionId: 'host-1' }));
    const shareState = vi.fn(async () => ({
      mode: 'relay-host' as const,
      localPath: '/tmp/README.md',
      relayRoomId: 'relay-room-1',
      hostOnline: true,
      hostSessionId: 'host-1',
      sharedRevision: 1,
      lastSharedHash: 'sha256:shared',
      links: [],
      sessions: [],
    }));
    const app = createHttpApp(createLocalOnlyPool(), createUnavailableLiveMarkdownWriter(), {
      localFileService: service,
      localDaemonToken: 'local-secret',
      localMode: true,
      localRelayHost: {
        relayRoomId: null,
        resumeHosted: vi.fn(async () => false),
        ensureHosted,
        start: vi.fn(async () => undefined),
        stop: vi.fn(),
        createLink: vi.fn(async () => {
          throw new Error('unexpected_create_link');
        }),
        revokeLink: vi.fn(async () => undefined),
        shareState,
        verifySharedState: vi.fn(async () => undefined),
        publishResolvedState: vi.fn(async () => ({
          sharedRevision: 2,
          sharedHash: 'sha256:shared',
          hostSessionId: 'host-1',
        })),
      },
    });

    const response = await request(app)
      .post('/api/local/sharing')
      .set('Authorization', 'Bearer local-secret')
      .expect(200);

    expect(response.body).toMatchObject({
      relayRoomId: 'relay-room-1',
      hostOnline: true,
    });
    expect(ensureHosted).toHaveBeenCalledOnce();
    expect(shareState).toHaveBeenCalledOnce();
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

  it('does not mount hosted AI write routes by default in hosted relay mode', async () => {
    const app = createHttpApp(createLocalOnlyPool(), createUnavailableLiveMarkdownWriter());

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
