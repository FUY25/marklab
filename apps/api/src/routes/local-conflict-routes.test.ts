import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '@marklab/shared/src/hash';
import type { DbPool } from '../db/client';
import { createHttpApp } from '../http/app';
import { createLocalFileServiceWithOptions, type LocalFileService } from '../local/local-file-service';
import { createInMemoryRelayRoomService, type RelayRoomService } from '../relay/relay-room-service';
import { createUnavailableLiveMarkdownWriter } from '../services/live-writer';
import { createHeadlessMilkdownRuntime } from '../services/milkdown-headless-runtime';

const runtime = createHeadlessMilkdownRuntime();

function createLocalOnlyPool(): DbPool {
  async function unavailable(): Promise<never> {
    throw new Error('database_not_configured');
  }

  return {
    query: unavailable,
    connect: unavailable,
  };
}

async function createTempMarkdown(markdown: string): Promise<{ file: string; metadataPath: string; conflictPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'marklab-local-conflict-routes-'));
  const file = join(directory, 'note.md');
  const metadataPath = join(directory, 'metadata', 'marklab-local.json');
  const conflictPath = join(directory, 'metadata', 'marklab-conflicts.json');
  await mkdir(join(directory, 'metadata'), { recursive: true });
  await writeFile(file, markdown, 'utf8');
  return { file, metadataPath, conflictPath };
}

async function encodeMarkdown(markdown: string): Promise<{ yjsState: Uint8Array; yjsStateBase64: string; hash: string }> {
  const initialized = await runtime.initializeFromMarkdown(markdown);
  return {
    yjsState: initialized.yjsState,
    yjsStateBase64: Buffer.from(initialized.yjsState).toString('base64'),
    hash: sha256Hex(initialized.markdown),
  };
}

async function createConflictFixture(input: {
  localMarkdown?: string;
  sharedMarkdown?: string;
  relayRole?: 'view' | 'edit';
} = {}): Promise<{
  service: LocalFileService;
  relayService: RelayRoomService;
  conflictId: string;
  expectedSharedRevision: number;
  expectedSharedHash: string;
  file: string;
}> {
  const localMarkdown = input.localMarkdown ?? '# Local\n';
  const sharedMarkdown = input.sharedMarkdown ?? '# Shared\n';
  const { file, metadataPath, conflictPath } = await createTempMarkdown(localMarkdown);
  const service = await createLocalFileServiceWithOptions(file, { metadataPath, conflictPath });
  const relayService = createInMemoryRelayRoomService();
  const shared = await encodeMarkdown(sharedMarkdown);
  const room = await relayService.createRoom({
    hostSessionId: 'host_1',
    hostAuthToken: 'host-token',
    lastEphemeralYjsState: shared.yjsState,
    lastSharedHash: shared.hash,
  });
  await service.saveRelayJoinState({
    schemaVersion: 1,
    relayRoomId: room.relayRoomId,
    grantId: 'grant_1',
    sessionId: 'session_1',
    localDocId: service.getSummary().localDocId,
    absolutePath: service.getSummary().absolutePath,
    lastAcceptedLocalHash: sha256Hex('# Base\n'),
    lastAcceptedSharedHash: sha256Hex('# Base\n'),
    lastAcceptedSharedRevision: 0,
    lastHostSessionId: 'host_1',
    disconnectedCleanly: false,
    relayRole: input.relayRole ?? 'edit',
    updatedAt: '2026-05-01T00:00:00.000Z',
  });
  const conflict = await service.openReconnectConflict({
    relayRoomId: room.relayRoomId,
    sharedRevision: room.sharedRevision,
    sharedHash: shared.hash,
    sharedYjsStateBase64: shared.yjsStateBase64,
    baseMarkdown: '# Base\n',
    baseYjsStateBase64: (await encodeMarkdown('# Base\n')).yjsStateBase64,
    baseHash: sha256Hex('# Base\n'),
  });

  return {
    service,
    relayService,
    conflictId: conflict.conflictId,
    expectedSharedRevision: conflict.sharedRevision,
    expectedSharedHash: conflict.sharedHash,
    file,
  };
}

describe('local conflict routes', () => {
  it('returns current and historical conflict packages with full reconciliation fields', async () => {
    const { service, conflictId } = await createConflictFixture();
    const app = createHttpApp(createLocalOnlyPool(), createUnavailableLiveMarkdownWriter(), {
      localFileService: service,
      localDaemonToken: 'local-secret',
      localMode: true,
    });

    const current = await request(app)
      .get('/api/local/conflicts/current')
      .set('Authorization', 'Bearer local-secret')
      .expect(200);
    const historical = await request(app)
      .get(`/api/local/conflicts/${conflictId}`)
      .set('Authorization', 'Bearer local-secret')
      .expect(200);

    for (const response of [current, historical]) {
      expect(response.body.conflict).toMatchObject({
        conflictId,
        baseMarkdown: '# Base\n',
        baseHash: sha256Hex('# Base\n'),
        lastProjectedMarkdown: '# Local\n',
        lastProjectedHash: sha256Hex('# Local\n'),
        localMarkdown: '# Local\n',
        localHash: sha256Hex('# Local\n'),
        sharedMarkdown: '# Shared\n',
        sharedHash: sha256Hex('# Shared\n'),
        sharedStateFingerprint: expect.stringMatching(/^sha256:/u),
        sharedRevision: expect.any(Number),
        status: 'open',
      });
    }
  });

  it('blocks local flush while an open conflict is paused', async () => {
    const { service } = await createConflictFixture();
    const flushCollabDocument = vi.fn(async () => undefined);
    const app = createHttpApp(createLocalOnlyPool(), createUnavailableLiveMarkdownWriter(), {
      localFileService: service,
      localDaemonToken: 'local-secret',
      localMode: true,
      flushCollabDocument,
    });

    const response = await request(app)
      .post('/api/local/flush')
      .set('Authorization', 'Bearer local-secret')
      .expect(409);

    expect(response.body).toEqual({ error: 'conflict_required' });
    expect(flushCollabDocument).not.toHaveBeenCalled();
  });

  it('returns stale_conflict_shared_state before mutating local state when relay revision advanced', async () => {
    const { service, relayService, conflictId, expectedSharedRevision, expectedSharedHash, file } = await createConflictFixture();
    const nextShared = await encodeMarkdown('# Shared advanced\n');
    await relayService.acceptSharedState({
      relayRoomId: service.getCurrentConflict()!.relayRoomId,
      yjsState: nextShared.yjsState,
      sharedHash: nextShared.hash,
    });
    const app = createHttpApp(createLocalOnlyPool(), createUnavailableLiveMarkdownWriter(), {
      localFileService: service,
      localDaemonToken: 'local-secret',
      localMode: true,
      relayService,
    });

    const response = await request(app)
      .post(`/api/local/conflicts/${conflictId}/use-local`)
      .set('Authorization', 'Bearer local-secret')
      .send({ expectedSharedRevision, expectedSharedHash })
      .expect(409);

    expect(response.body).toEqual({ error: 'stale_conflict_shared_state' });
    expect(await readFile(file, 'utf8')).toBe('# Local\n');
    expect(service.getCurrentConflict()?.status).toBe('open');
  });

  it('returns invalid_request for malformed conflict resolution bodies before mutating local state', async () => {
    const { service, relayService, conflictId, expectedSharedRevision, expectedSharedHash, file } = await createConflictFixture();
    const app = createHttpApp(createLocalOnlyPool(), createUnavailableLiveMarkdownWriter(), {
      localFileService: service,
      localDaemonToken: 'local-secret',
      localMode: true,
      relayService,
      applyCollabDocumentState: vi.fn(async () => undefined),
    });

    const useSharedResponse = await request(app)
      .post(`/api/local/conflicts/${conflictId}/use-shared`)
      .set('Authorization', 'Bearer local-secret')
      .send({})
      .expect(400);
    const resolveResponse = await request(app)
      .post(`/api/local/conflicts/${conflictId}/resolve`)
      .set('Authorization', 'Bearer local-secret')
      .send({ expectedSharedRevision, expectedSharedHash })
      .expect(400);

    expect(useSharedResponse.body.error).toBe('invalid_request');
    expect(resolveResponse.body.error).toBe('invalid_request');
    expect(await readFile(file, 'utf8')).toBe('# Local\n');
    expect(service.getCurrentConflict()).toMatchObject({
      conflictId,
      status: 'open',
      localMarkdown: '# Local\n',
      sharedMarkdown: '# Shared\n',
    });
  });

  it('accepts empty expected shared hashes for relay states that have no published hash yet', async () => {
    const { file, metadataPath, conflictPath } = await createTempMarkdown('# Local\n');
    const service = await createLocalFileServiceWithOptions(file, { metadataPath, conflictPath });
    const relayService = createInMemoryRelayRoomService();
    const shared = await encodeMarkdown('# Shared\n');
    const room = await relayService.createRoom({
      hostSessionId: 'host_1',
      hostAuthToken: 'host-token',
      lastSharedHash: null,
    });
    await service.saveRelayJoinState({
      schemaVersion: 1,
      relayRoomId: room.relayRoomId,
      grantId: 'grant_1',
      sessionId: 'session_1',
      localDocId: service.getSummary().localDocId,
      absolutePath: service.getSummary().absolutePath,
      lastAcceptedLocalHash: sha256Hex('# Base\n'),
      lastAcceptedSharedHash: '',
      lastAcceptedSharedRevision: 0,
      lastHostSessionId: 'host_1',
      disconnectedCleanly: false,
      relayRole: 'edit',
      updatedAt: '2026-05-01T00:00:00.000Z',
    });
    const conflict = await service.openReconnectConflict({
      relayRoomId: room.relayRoomId,
      sharedRevision: room.sharedRevision,
      sharedHash: shared.hash,
      expectedSharedRevision: room.sharedRevision,
      expectedSharedHash: '',
      sharedYjsStateBase64: shared.yjsStateBase64,
      baseMarkdown: '# Base\n',
      baseYjsStateBase64: (await encodeMarkdown('# Base\n')).yjsStateBase64,
      baseHash: sha256Hex('# Base\n'),
    });
    const app = createHttpApp(createLocalOnlyPool(), createUnavailableLiveMarkdownWriter(), {
      localFileService: service,
      localDaemonToken: 'local-secret',
      localMode: true,
      relayService,
      applyCollabDocumentState: vi.fn(async () => undefined),
    });

    const response = await request(app)
      .post(`/api/local/conflicts/${conflict.conflictId}/use-local`)
      .set('Authorization', 'Bearer local-secret')
      .send({ expectedSharedRevision: conflict.expectedSharedRevision, expectedSharedHash: conflict.expectedSharedHash })
      .expect(200);

    expect(response.body).toMatchObject({ conflictId: conflict.conflictId, status: 'resolved' });
    expect(await readFile(file, 'utf8')).toBe('# Local\n');
  });

  it('resumes a host relay after keep-shared resolves a host-side reconnect conflict', async () => {
    const { service, conflictId, expectedSharedRevision, expectedSharedHash, file } = await createConflictFixture();
    const resumeHosted = vi.fn(async () => true);
    const app = createHttpApp(createLocalOnlyPool(), createUnavailableLiveMarkdownWriter(), {
      localFileService: service,
      localDaemonToken: 'local-secret',
      localMode: true,
      localRelayHost: {
        relayRoomId: service.getCurrentConflict()!.relayRoomId,
        resumeHosted,
        ensureHosted: vi.fn(async () => ({ relayRoomId: service.getCurrentConflict()!.relayRoomId, hostSessionId: 'host_1' })),
        start: vi.fn(async () => undefined),
        stop: vi.fn(),
        createLink: vi.fn(),
        revokeLink: vi.fn(),
        shareState: vi.fn(async () => ({
          mode: 'relay-host' as const,
          localPath: service.getSummary().absolutePath,
          relayRoomId: service.getCurrentConflict()!.relayRoomId,
          hostOnline: false,
          hostSessionId: 'host_1',
          sharedRevision: expectedSharedRevision,
          lastSharedHash: expectedSharedHash,
          links: [],
          sessions: [],
        })),
        verifySharedState: vi.fn(async () => {
          throw new Error('host_offline');
        }),
        publishResolvedState: vi.fn(),
      },
      applyCollabDocumentState: vi.fn(async () => undefined),
    });

    const response = await request(app)
      .post(`/api/local/conflicts/${conflictId}/use-shared`)
      .set('Authorization', 'Bearer local-secret')
      .send({ expectedSharedRevision, expectedSharedHash })
      .expect(200);

    expect(response.body).toMatchObject({ conflictId, status: 'resolved' });
    expect(await readFile(file, 'utf8')).toBe('# Shared\n');
    expect(resumeHosted).toHaveBeenCalledOnce();
  });

  it('returns stale_conflict_shared_state before keeping shared when relay revision advanced', async () => {
    const { service, relayService, conflictId, expectedSharedRevision, expectedSharedHash, file } = await createConflictFixture();
    const nextShared = await encodeMarkdown('# Shared advanced\n');
    await relayService.acceptSharedState({
      relayRoomId: service.getCurrentConflict()!.relayRoomId,
      yjsState: nextShared.yjsState,
      sharedHash: nextShared.hash,
    });
    const app = createHttpApp(createLocalOnlyPool(), createUnavailableLiveMarkdownWriter(), {
      localFileService: service,
      localDaemonToken: 'local-secret',
      localMode: true,
      relayService,
      applyCollabDocumentState: vi.fn(async () => undefined),
    });

    const response = await request(app)
      .post(`/api/local/conflicts/${conflictId}/use-shared`)
      .set('Authorization', 'Bearer local-secret')
      .send({ expectedSharedRevision, expectedSharedHash })
      .expect(409);

    expect(response.body).toEqual({ error: 'stale_conflict_shared_state' });
    expect(await readFile(file, 'utf8')).toBe('# Local\n');
    expect(service.getCurrentConflict()?.status).toBe('open');
  });

  it('returns local_state_changed before use-shared overwrites disk edits made after conflict opened', async () => {
    const { service, relayService, conflictId, expectedSharedRevision, expectedSharedHash, file } = await createConflictFixture();
    await writeFile(file, '# Local changed again\n', 'utf8');
    const app = createHttpApp(createLocalOnlyPool(), createUnavailableLiveMarkdownWriter(), {
      localFileService: service,
      localDaemonToken: 'local-secret',
      localMode: true,
      relayService,
      applyCollabDocumentState: vi.fn(async () => undefined),
    });

    const response = await request(app)
      .post(`/api/local/conflicts/${conflictId}/use-shared`)
      .set('Authorization', 'Bearer local-secret')
      .send({ expectedSharedRevision, expectedSharedHash })
      .expect(409);

    expect(response.body).toEqual({ error: 'local_state_changed' });
    expect(await readFile(file, 'utf8')).toBe('# Local changed again\n');
    expect(service.getCurrentConflict()).toMatchObject({
      status: 'open',
      localMarkdown: '# Local changed again\n',
      localHash: sha256Hex('# Local changed again\n'),
      sharedMarkdown: '# Shared\n',
      sharedRevision: expectedSharedRevision,
    });
  });

  it('returns local_state_changed before use-local overwrites disk edits made after conflict opened', async () => {
    const { service, relayService, conflictId, expectedSharedRevision, expectedSharedHash, file } = await createConflictFixture();
    await writeFile(file, '# Local changed again\n', 'utf8');
    const app = createHttpApp(createLocalOnlyPool(), createUnavailableLiveMarkdownWriter(), {
      localFileService: service,
      localDaemonToken: 'local-secret',
      localMode: true,
      relayService,
      applyCollabDocumentState: vi.fn(async () => undefined),
    });

    const response = await request(app)
      .post(`/api/local/conflicts/${conflictId}/use-local`)
      .set('Authorization', 'Bearer local-secret')
      .send({ expectedSharedRevision, expectedSharedHash })
      .expect(409);

    expect(response.body).toEqual({ error: 'local_state_changed' });
    expect(await readFile(file, 'utf8')).toBe('# Local changed again\n');
    expect(service.getCurrentConflict()).toMatchObject({
      status: 'open',
      localMarkdown: '# Local changed again\n',
      localHash: sha256Hex('# Local changed again\n'),
      sharedMarkdown: '# Shared\n',
      sharedRevision: expectedSharedRevision,
    });
  });

  it('returns stale_conflict_shared_state before use-shared local commit when active provider advanced', async () => {
    const { service, relayService, conflictId, expectedSharedRevision, expectedSharedHash, file } = await createConflictFixture();
    const verifyCollabDocumentState = vi.fn(async () => {
      throw new Error('stale_conflict_shared_state');
    });
    const closeCollabDocumentConnections = vi.fn();
    const app = createHttpApp(createLocalOnlyPool(), createUnavailableLiveMarkdownWriter(), {
      localFileService: service,
      localDaemonToken: 'local-secret',
      localMode: true,
      relayService,
      verifyCollabDocumentState,
      closeCollabDocumentConnections,
      applyCollabDocumentState: vi.fn(async () => undefined),
    });

    const response = await request(app)
      .post(`/api/local/conflicts/${conflictId}/use-shared`)
      .set('Authorization', 'Bearer local-secret')
      .send({ expectedSharedRevision, expectedSharedHash })
      .expect(409);

    expect(response.body).toEqual({ error: 'stale_conflict_shared_state' });
    expect(verifyCollabDocumentState).toHaveBeenCalledWith(service.roomName, {
      expectedCurrentHash: expectedSharedHash,
    });
    expect(closeCollabDocumentConnections).not.toHaveBeenCalled();
    expect(await readFile(file, 'utf8')).toBe('# Local\n');
    expect(service.getCurrentConflict()).toMatchObject({
      conflictId,
      status: 'open',
      localMarkdown: '# Local\n',
      sharedMarkdown: '# Shared\n',
    });
  });

  it('keeps shared locally without relay publish when mirror host is offline', async () => {
    const { service, conflictId, expectedSharedRevision, expectedSharedHash, file } = await createConflictFixture();
    const verifySharedState = vi.fn(async () => {
      throw new Error('host_offline');
    });
    const publishResolvedState = vi.fn(async () => {
      throw new Error('unexpected_publish');
    });
    const app = createHttpApp(createLocalOnlyPool(), createUnavailableLiveMarkdownWriter(), {
      localFileService: service,
      localDaemonToken: 'local-secret',
      localMode: true,
      localRelayMirror: {
        start: vi.fn(async () => undefined),
        stop: vi.fn(),
        shareState: vi.fn(async () => ({
          mode: 'relay-mirror' as const,
          localPath: service.getSummary().absolutePath,
          relayRoomId: service.getCurrentConflict()!.relayRoomId,
          hostOnline: false,
          hostSessionId: null,
          sharedRevision: expectedSharedRevision,
          lastSharedHash: expectedSharedHash,
          links: [],
          sessions: [],
        })),
        verifySharedState,
        publishResolvedState,
      },
      applyCollabDocumentState: vi.fn(async () => undefined),
    });

    const response = await request(app)
      .post(`/api/local/conflicts/${conflictId}/use-shared`)
      .set('Authorization', 'Bearer local-secret')
      .send({ expectedSharedRevision, expectedSharedHash })
      .expect(200);

    expect(response.body).toMatchObject({ conflictId, status: 'resolved', hash: expectedSharedHash });
    expect(verifySharedState).toHaveBeenCalled();
    expect(publishResolvedState).not.toHaveBeenCalled();
    expect(await readFile(file, 'utf8')).toBe('# Shared\n');
    expect(service.getCurrentConflict()).toBeNull();
  });

  it('returns host_offline and keeps the refreshed local conflict open when mirror publish fails after provider apply', async () => {
    const { service, conflictId, expectedSharedRevision, expectedSharedHash, file } = await createConflictFixture();
    let activeProviderHash = expectedSharedHash;
    const applyCollabDocumentState = vi.fn(async (_roomName: string, yjsState: Uint8Array, options?: { expectedCurrentHash?: string }) => {
      if (options?.expectedCurrentHash !== activeProviderHash) throw new Error('stale_conflict_shared_state');
      const serialized = await runtime.serializeYjsState(yjsState);
      activeProviderHash = serialized.hash;
      return yjsState;
    });
    const app = createHttpApp(createLocalOnlyPool(), createUnavailableLiveMarkdownWriter(), {
      localFileService: service,
      localDaemonToken: 'local-secret',
      localMode: true,
      localRelayMirror: {
        start: vi.fn(async () => undefined),
        stop: vi.fn(),
        shareState: vi.fn(async () => ({
          mode: 'relay-mirror' as const,
          localPath: service.getSummary().absolutePath,
          relayRoomId: service.getCurrentConflict()!.relayRoomId,
          hostOnline: true,
          hostSessionId: 'host_1',
          sharedRevision: expectedSharedRevision,
          lastSharedHash: expectedSharedHash,
          links: [],
          sessions: [],
        })),
        verifySharedState: vi.fn(async () => undefined),
        publishResolvedState: vi.fn(async () => {
          throw new Error('host_offline');
        }),
      },
      applyCollabDocumentState,
    });

    const response = await request(app)
      .post(`/api/local/conflicts/${conflictId}/resolve`)
      .set('Authorization', 'Bearer local-secret')
      .send({
        markdown: '# Resolved\n',
        expectedSharedRevision,
        expectedSharedHash,
      })
      .expect(409);

    expect(response.body).toEqual({ error: 'host_offline' });
    expect(await readFile(file, 'utf8')).toBe('# Local\n');
    expect(activeProviderHash).toBe(expectedSharedHash);
    expect(service.getCurrentConflict()).toMatchObject({
      status: 'open',
      localMarkdown: '# Local\n',
      sharedMarkdown: '# Shared\n',
      sharedRevision: expectedSharedRevision,
    });
    expect(applyCollabDocumentState).toHaveBeenCalledWith(service.roomName, expect.any(Uint8Array), {
      expectedCurrentHash: expectedSharedHash,
    });
    expect(applyCollabDocumentState).toHaveBeenCalledWith(service.roomName, expect.any(Uint8Array), {
      expectedCurrentHash: sha256Hex('# Resolved\n'),
    });
  });

  it('forbids view-only relay roles from publishing local conflict resolutions', async () => {
    const { service, relayService, conflictId, expectedSharedRevision, expectedSharedHash, file } = await createConflictFixture({
      relayRole: 'view',
    });
    const publishSpy = vi.spyOn(relayService, 'acceptSharedState');
    const app = createHttpApp(createLocalOnlyPool(), createUnavailableLiveMarkdownWriter(), {
      localFileService: service,
      localDaemonToken: 'local-secret',
      localMode: true,
      relayService,
      applyCollabDocumentState: vi.fn(async () => undefined),
    });

    const response = await request(app)
      .post(`/api/local/conflicts/${conflictId}/use-local`)
      .set('Authorization', 'Bearer local-secret')
      .send({ expectedSharedRevision, expectedSharedHash })
      .expect(403);

    expect(response.body).toEqual({ error: 'forbidden' });
    expect(await readFile(file, 'utf8')).toBe('# Local\n');
    expect(service.getCurrentConflict()?.status).toBe('open');
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it('does not publish when disk changes during the final pre-publish local commit guard', async () => {
    const { file, metadataPath, conflictPath } = await createTempMarkdown('# Local\n');
    let mutateBeforeCommit = false;
    const service = await createLocalFileServiceWithOptions(file, {
      metadataPath,
      conflictPath,
      beforeConflictResolutionCommit: async () => {
        if (mutateBeforeCommit) await writeFile(file, '# Local changed before publish\n', 'utf8');
      },
    });
    const relayService = createInMemoryRelayRoomService();
    const shared = await encodeMarkdown('# Shared\n');
    const room = await relayService.createRoom({
      hostSessionId: 'host_1',
      hostAuthToken: 'host-token',
      lastEphemeralYjsState: shared.yjsState,
      lastSharedHash: shared.hash,
    });
    await service.saveRelayJoinState({
      schemaVersion: 1,
      relayRoomId: room.relayRoomId,
      grantId: 'grant_1',
      sessionId: 'session_1',
      localDocId: service.getSummary().localDocId,
      absolutePath: service.getSummary().absolutePath,
      lastAcceptedLocalHash: sha256Hex('# Base\n'),
      lastAcceptedSharedHash: sha256Hex('# Base\n'),
      lastAcceptedSharedRevision: 0,
      lastHostSessionId: 'host_1',
      disconnectedCleanly: false,
      relayRole: 'edit',
      updatedAt: '2026-05-01T00:00:00.000Z',
    });
    const conflict = await service.openReconnectConflict({
      relayRoomId: room.relayRoomId,
      sharedRevision: room.sharedRevision,
      sharedHash: shared.hash,
      sharedYjsStateBase64: shared.yjsStateBase64,
      baseMarkdown: '# Base\n',
      baseYjsStateBase64: (await encodeMarkdown('# Base\n')).yjsStateBase64,
      baseHash: sha256Hex('# Base\n'),
    });
    mutateBeforeCommit = true;
    const app = createHttpApp(createLocalOnlyPool(), createUnavailableLiveMarkdownWriter(), {
      localFileService: service,
      localDaemonToken: 'local-secret',
      localMode: true,
      relayService,
      applyCollabDocumentState: vi.fn(async () => undefined),
    });

    const publishSpy = vi.spyOn(relayService, 'acceptSharedState');
    const response = await request(app)
      .post(`/api/local/conflicts/${conflict.conflictId}/use-local`)
      .set('Authorization', 'Bearer local-secret')
      .send({ expectedSharedRevision: conflict.sharedRevision, expectedSharedHash: conflict.sharedHash })
      .expect(409);

    expect(response.body).toEqual({ error: 'local_state_changed' });
    expect(await readFile(file, 'utf8')).toBe('# Local changed before publish\n');
    expect(service.getCurrentConflict()).toMatchObject({
      conflictId: conflict.conflictId,
      status: 'open',
      localMarkdown: '# Local changed before publish\n',
      sharedMarkdown: '# Shared\n',
      sharedRevision: conflict.sharedRevision,
      sharedHash: sha256Hex('# Shared\n'),
    });
    expect(publishSpy).not.toHaveBeenCalled();
    expect(await relayService.getRoom(conflict.relayRoomId)).toMatchObject({
      sharedRevision: conflict.sharedRevision,
      lastSharedHash: sha256Hex('# Shared\n'),
    });
  });

  it('keeps conflict open and disk unchanged when local provider apply fails before relay publish', async () => {
    const { service, relayService, conflictId, expectedSharedRevision, expectedSharedHash, file } = await createConflictFixture();
    const app = createHttpApp(createLocalOnlyPool(), createUnavailableLiveMarkdownWriter(), {
      localFileService: service,
      localDaemonToken: 'local-secret',
      localMode: true,
      relayService,
      applyCollabDocumentState: vi.fn(async () => {
        throw new Error('local_provider_unavailable');
      }),
    });
    const publishSpy = vi.spyOn(relayService, 'acceptSharedState');

    const response = await request(app)
      .post(`/api/local/conflicts/${conflictId}/use-local`)
      .set('Authorization', 'Bearer local-secret')
      .send({ expectedSharedRevision, expectedSharedHash })
      .expect(500);

    expect(response.body).toEqual({ error: 'internal_error' });
    expect(await readFile(file, 'utf8')).toBe('# Local\n');
    expect(service.getCurrentConflict()).toMatchObject({
      conflictId,
      status: 'open',
      localMarkdown: '# Local\n',
      sharedMarkdown: '# Shared\n',
      sharedRevision: expectedSharedRevision,
      sharedHash: sha256Hex('# Shared\n'),
    });
    expect(publishSpy).not.toHaveBeenCalled();
    expect(await relayService.getRoom(service.getCurrentConflict()!.relayRoomId)).toMatchObject({
      sharedRevision: expectedSharedRevision,
      lastSharedHash: sha256Hex('# Shared\n'),
    });
  });

  it('returns stale_conflict_shared_state before relay publish when active provider already advanced', async () => {
    const { service, relayService, conflictId, expectedSharedRevision, expectedSharedHash, file } = await createConflictFixture();
    const publishSpy = vi.spyOn(relayService, 'acceptSharedState');
    const verifyCollabDocumentState = vi.fn(async () => {
      throw new Error('stale_conflict_shared_state');
    });
    const closeCollabDocumentConnections = vi.fn();
    const app = createHttpApp(createLocalOnlyPool(), createUnavailableLiveMarkdownWriter(), {
      localFileService: service,
      localDaemonToken: 'local-secret',
      localMode: true,
      relayService,
      verifyCollabDocumentState,
      closeCollabDocumentConnections,
      applyCollabDocumentState: vi.fn(async () => {
        throw new Error('stale_conflict_shared_state');
      }),
    });

    const response = await request(app)
      .post(`/api/local/conflicts/${conflictId}/use-local`)
      .set('Authorization', 'Bearer local-secret')
      .send({ expectedSharedRevision, expectedSharedHash })
      .expect(409);

    expect(response.body).toEqual({ error: 'stale_conflict_shared_state' });
    expect(verifyCollabDocumentState).toHaveBeenCalledWith(service.roomName, {
      expectedCurrentHash: expectedSharedHash,
    });
    expect(closeCollabDocumentConnections).not.toHaveBeenCalled();
    expect(publishSpy).not.toHaveBeenCalled();
    expect(await readFile(file, 'utf8')).toBe('# Local\n');
    expect(service.getCurrentConflict()).toMatchObject({
      conflictId,
      status: 'open',
      localMarkdown: '# Local\n',
      sharedMarkdown: '# Shared\n',
      sharedRevision: expectedSharedRevision,
      sharedHash: expectedSharedHash,
    });
    expect(await relayService.getRoom(service.getCurrentConflict()!.relayRoomId)).toMatchObject({
      sharedRevision: expectedSharedRevision,
      lastSharedHash: expectedSharedHash,
    });
  });

  it('keeps conflict open and disk unchanged when use-shared cannot apply the active provider state', async () => {
    const { service, relayService, conflictId, expectedSharedRevision, expectedSharedHash, file } = await createConflictFixture();
    const app = createHttpApp(createLocalOnlyPool(), createUnavailableLiveMarkdownWriter(), {
      localFileService: service,
      localDaemonToken: 'local-secret',
      localMode: true,
      relayService,
      applyCollabDocumentState: vi.fn(async () => {
        throw new Error('local_provider_unavailable');
      }),
    });

    const response = await request(app)
      .post(`/api/local/conflicts/${conflictId}/use-shared`)
      .set('Authorization', 'Bearer local-secret')
      .send({ expectedSharedRevision, expectedSharedHash })
      .expect(500);

    expect(response.body).toEqual({ error: 'internal_error' });
    expect(await readFile(file, 'utf8')).toBe('# Local\n');
    expect(service.getCurrentConflict()).toMatchObject({
      conflictId,
      status: 'open',
      localMarkdown: '# Local\n',
      sharedMarkdown: '# Shared\n',
      sharedRevision: expectedSharedRevision,
      sharedHash: sha256Hex('# Shared\n'),
    });
  });

  it('keeps the conflict open with a missing-file error when the backing file disappears before resolution', async () => {
    const { service, relayService, conflictId, expectedSharedRevision, expectedSharedHash, file } = await createConflictFixture();
    await rm(file, { force: true });
    const app = createHttpApp(createLocalOnlyPool(), createUnavailableLiveMarkdownWriter(), {
      localFileService: service,
      localDaemonToken: 'local-secret',
      localMode: true,
      relayService,
      applyCollabDocumentState: vi.fn(async () => undefined),
    });

    const response = await request(app)
      .post(`/api/local/conflicts/${conflictId}/use-shared`)
      .set('Authorization', 'Bearer local-secret')
      .send({ expectedSharedRevision, expectedSharedHash })
      .expect(409);

    expect(response.body).toEqual({ error: 'host_file_missing' });
    expect(service.getSummary().conflict).toBe('host_file_missing');
    expect(service.getCurrentConflict()).toMatchObject({
      conflictId,
      status: 'open',
      localMarkdown: '# Local\n',
      sharedMarkdown: '# Shared\n',
    });
  });

  it('keeps conflict open when the active provider returns a mismatched resolved state', async () => {
    const { service, relayService, conflictId, expectedSharedRevision, expectedSharedHash, file } = await createConflictFixture();
    const mismatched = await encodeMarkdown('# Wrong provider state\n');
    const app = createHttpApp(createLocalOnlyPool(), createUnavailableLiveMarkdownWriter(), {
      localFileService: service,
      localDaemonToken: 'local-secret',
      localMode: true,
      relayService,
      applyCollabDocumentState: vi.fn(async () => mismatched.yjsState),
    });

    const response = await request(app)
      .post(`/api/local/conflicts/${conflictId}/use-shared`)
      .set('Authorization', 'Bearer local-secret')
      .send({ expectedSharedRevision, expectedSharedHash })
      .expect(500);

    expect(response.body).toEqual({ error: 'internal_error' });
    expect(await readFile(file, 'utf8')).toBe('# Local\n');
    expect(service.getCurrentConflict()).toMatchObject({
      conflictId,
      status: 'open',
      localMarkdown: '# Local\n',
      sharedMarkdown: '# Shared\n',
    });
  });

  it('keeps conflict open when disk changes after local conflict commit but before completion', async () => {
    const { file, metadataPath, conflictPath } = await createTempMarkdown('# Local\n');
    let mutateBeforeComplete = false;
    const service = await createLocalFileServiceWithOptions(file, {
      metadataPath,
      conflictPath,
      beforeConflictResolutionComplete: async () => {
        if (mutateBeforeComplete) await writeFile(file, '# Local changed after commit\n', 'utf8');
      },
    });
    const relayService = createInMemoryRelayRoomService();
    const shared = await encodeMarkdown('# Shared\n');
    const room = await relayService.createRoom({
      hostSessionId: 'host_1',
      hostAuthToken: 'host-token',
      lastEphemeralYjsState: shared.yjsState,
      lastSharedHash: shared.hash,
    });
    await service.saveRelayJoinState({
      schemaVersion: 1,
      relayRoomId: room.relayRoomId,
      grantId: 'grant_1',
      sessionId: 'session_1',
      localDocId: service.getSummary().localDocId,
      absolutePath: service.getSummary().absolutePath,
      lastAcceptedLocalHash: sha256Hex('# Base\n'),
      lastAcceptedSharedHash: sha256Hex('# Base\n'),
      lastAcceptedSharedRevision: 0,
      lastHostSessionId: 'host_1',
      disconnectedCleanly: false,
      relayRole: 'edit',
      updatedAt: '2026-05-01T00:00:00.000Z',
    });
    const conflict = await service.openReconnectConflict({
      relayRoomId: room.relayRoomId,
      sharedRevision: room.sharedRevision,
      sharedHash: shared.hash,
      sharedYjsStateBase64: shared.yjsStateBase64,
      baseMarkdown: '# Base\n',
      baseYjsStateBase64: (await encodeMarkdown('# Base\n')).yjsStateBase64,
      baseHash: sha256Hex('# Base\n'),
    });
    mutateBeforeComplete = true;
    const app = createHttpApp(createLocalOnlyPool(), createUnavailableLiveMarkdownWriter(), {
      localFileService: service,
      localDaemonToken: 'local-secret',
      localMode: true,
      relayService,
      applyCollabDocumentState: vi.fn(async () => undefined),
    });

    const response = await request(app)
      .post(`/api/local/conflicts/${conflict.conflictId}/use-local`)
      .set('Authorization', 'Bearer local-secret')
      .send({ expectedSharedRevision: conflict.sharedRevision, expectedSharedHash: conflict.sharedHash })
      .expect(409);

    expect(response.body).toEqual({ error: 'local_state_changed' });
    expect(await readFile(file, 'utf8')).toBe('# Local changed after commit\n');
    expect(service.getCurrentConflict()).toMatchObject({
      conflictId: conflict.conflictId,
      status: 'open',
      localMarkdown: '# Local changed after commit\n',
      sharedMarkdown: '# Local\n',
      sharedRevision: conflict.sharedRevision + 1,
      sharedHash: sha256Hex('# Local\n'),
    });
    expect(await relayService.getRoom(conflict.relayRoomId)).toMatchObject({
      sharedRevision: conflict.sharedRevision + 1,
      lastSharedHash: sha256Hex('# Local\n'),
    });
  });

  it('serializes concurrent resolution requests so provider and disk resolve to the same side', async () => {
    const { service, conflictId, expectedSharedRevision, expectedSharedHash, file } = await createConflictFixture();
    let resolvePublishStarted: () => void = () => undefined;
    let releasePublish: () => void = () => undefined;
    const publishStarted = new Promise<void>((resolve) => {
      resolvePublishStarted = resolve;
    });
    const publishCanFinish = new Promise<void>((resolve) => {
      releasePublish = resolve;
    });
    const publishResolvedState = vi.fn(async (_input: { yjsState: Uint8Array }) => {
      resolvePublishStarted();
      await publishCanFinish;
      return {
        sharedRevision: expectedSharedRevision + 1,
        sharedHash: sha256Hex('# Local\n'),
        hostSessionId: 'host_1',
      };
    });
    const app = createHttpApp(createLocalOnlyPool(), createUnavailableLiveMarkdownWriter(), {
      localFileService: service,
      localDaemonToken: 'local-secret',
      localMode: true,
      localRelayMirror: {
        start: vi.fn(async () => undefined),
        stop: vi.fn(),
        shareState: vi.fn(async () => ({
          mode: 'relay-mirror' as const,
          localPath: service.getSummary().absolutePath,
          relayRoomId: service.getCurrentConflict()?.relayRoomId ?? 'relay_1',
          hostOnline: true,
          hostSessionId: 'host_1',
          sharedRevision: expectedSharedRevision,
          lastSharedHash: expectedSharedHash,
          links: [],
          sessions: [],
        })),
        verifySharedState: vi.fn(async () => undefined),
        publishResolvedState,
      },
      applyCollabDocumentState: vi.fn(async () => undefined),
    });

    let publishEntered = false;
    const first = request(app)
      .post(`/api/local/conflicts/${conflictId}/use-local`)
      .set('Authorization', 'Bearer local-secret')
      .send({ expectedSharedRevision, expectedSharedHash })
      .then((response) => response);

    await publishStarted.then(() => {
      publishEntered = true;
    });

    const second = request(app)
      .post(`/api/local/conflicts/${conflictId}/use-shared`)
      .set('Authorization', 'Bearer local-secret')
      .send({ expectedSharedRevision, expectedSharedHash })
      .then((response) => response);

    expect(publishEntered).toBe(true);
    releasePublish();
    const [firstResponse, secondResponse] = await Promise.all([first, second]);

    expect(firstResponse.status).toBe(200);
    expect(firstResponse.body).toMatchObject({
      conflictId,
      status: 'resolved',
      hash: sha256Hex('# Local\n'),
      sharedRevision: expectedSharedRevision + 1,
    });
    expect(secondResponse.status).toBe(409);
    expect(secondResponse.body).toMatchObject({
      error: 'conflict_already_resolved',
      hash: sha256Hex('# Local\n'),
      sharedRevision: expectedSharedRevision + 1,
    });
    expect(await readFile(file, 'utf8')).toBe('# Local\n');
    expect(service.getCurrentConflict()).toBeNull();
  });

  it('does not publish when local commit fails', async () => {
    const { file, metadataPath, conflictPath } = await createTempMarkdown('# Local\n');
    const service = await createLocalFileServiceWithOptions(file, {
      metadataPath,
      conflictPath,
      beforeConflictResolutionCommit: async () => {
        throw new Error('disk_full');
      },
    });
    const relayService = createInMemoryRelayRoomService();
    const shared = await encodeMarkdown('# Shared\n');
    const room = await relayService.createRoom({
      hostSessionId: 'host_1',
      hostAuthToken: 'host-token',
      lastEphemeralYjsState: shared.yjsState,
      lastSharedHash: shared.hash,
    });
    await service.saveRelayJoinState({
      schemaVersion: 1,
      relayRoomId: room.relayRoomId,
      grantId: 'grant_1',
      sessionId: 'session_1',
      localDocId: service.getSummary().localDocId,
      absolutePath: service.getSummary().absolutePath,
      lastAcceptedLocalHash: sha256Hex('# Base\n'),
      lastAcceptedSharedHash: sha256Hex('# Base\n'),
      lastAcceptedSharedRevision: 0,
      lastHostSessionId: 'host_1',
      disconnectedCleanly: false,
      relayRole: 'edit',
      updatedAt: '2026-05-01T00:00:00.000Z',
    });
    const conflict = await service.openReconnectConflict({
      relayRoomId: room.relayRoomId,
      sharedRevision: room.sharedRevision,
      sharedHash: shared.hash,
      sharedYjsStateBase64: shared.yjsStateBase64,
      baseMarkdown: '# Base\n',
      baseYjsStateBase64: (await encodeMarkdown('# Base\n')).yjsStateBase64,
      baseHash: sha256Hex('# Base\n'),
    });
    const app = createHttpApp(createLocalOnlyPool(), createUnavailableLiveMarkdownWriter(), {
      localFileService: service,
      localDaemonToken: 'local-secret',
      localMode: true,
      relayService,
      applyCollabDocumentState: vi.fn(async () => undefined),
    });
    const publishSpy = vi.spyOn(relayService, 'acceptSharedState');

    const response = await request(app)
      .post(`/api/local/conflicts/${conflict.conflictId}/use-local`)
      .set('Authorization', 'Bearer local-secret')
      .send({ expectedSharedRevision: conflict.sharedRevision, expectedSharedHash: conflict.sharedHash })
      .expect(500);

    expect(response.body).toEqual({ error: 'internal_error' });
    expect(await readFile(file, 'utf8')).toBe('# Local\n');
    expect(service.getCurrentConflict()).toMatchObject({
      conflictId: conflict.conflictId,
      status: 'open',
      localMarkdown: '# Local\n',
      sharedMarkdown: '# Shared\n',
      sharedRevision: conflict.sharedRevision,
      sharedHash: sha256Hex('# Shared\n'),
    });
    expect(publishSpy).not.toHaveBeenCalled();
    expect(await relayService.getRoom(conflict.relayRoomId)).toMatchObject({
      sharedRevision: conflict.sharedRevision,
      lastSharedHash: sha256Hex('# Shared\n'),
    });
  });

  it('publishes mirror use-local resolutions through the remote mirror controller', async () => {
    const { service, relayService, conflictId, expectedSharedRevision, expectedSharedHash } = await createConflictFixture();
    const relayPublishSpy = vi.spyOn(relayService, 'acceptSharedState');
    const verifySharedState = vi.fn(async () => undefined);
    const publishResolvedState = vi.fn(async (_input: { yjsState: Uint8Array }) => ({
      sharedRevision: expectedSharedRevision + 1,
      sharedHash: sha256Hex('# Local\n'),
      hostSessionId: 'host_1',
    }));
    const app = createHttpApp(createLocalOnlyPool(), createUnavailableLiveMarkdownWriter(), {
      localFileService: service,
      localDaemonToken: 'local-secret',
      localMode: true,
      relayService,
      localRelayMirror: {
        start: vi.fn(async () => undefined),
        stop: vi.fn(),
        shareState: vi.fn(async () => ({
          mode: 'relay-mirror' as const,
          localPath: service.getSummary().absolutePath,
          relayRoomId: service.getCurrentConflict()!.relayRoomId,
          hostOnline: true,
          hostSessionId: 'host_1',
          sharedRevision: expectedSharedRevision,
          lastSharedHash: expectedSharedHash,
          links: [],
          sessions: [],
        })),
        verifySharedState,
        publishResolvedState,
      },
      applyCollabDocumentState: vi.fn(async () => undefined),
    });

    const response = await request(app)
      .post(`/api/local/conflicts/${conflictId}/use-local`)
      .set('Authorization', 'Bearer local-secret')
      .send({ expectedSharedRevision, expectedSharedHash })
      .expect(200);

    expect(response.body).toMatchObject({
      conflictId,
      status: 'resolved',
      hash: sha256Hex('# Local\n'),
      sharedRevision: expectedSharedRevision + 1,
    });
    expect(verifySharedState).toHaveBeenCalledWith({ expectedSharedRevision, expectedSharedHash });
    expect(publishResolvedState).toHaveBeenCalledOnce();
    expect(publishResolvedState.mock.calls[0]?.[0]).toMatchObject({
      expectedSharedRevision,
      expectedSharedHash,
    });
    expect(publishResolvedState.mock.calls[0]?.[0].yjsState).toBeInstanceOf(Uint8Array);
    expect(relayPublishSpy).not.toHaveBeenCalled();
    expect(service.getRelayJoinState()).toMatchObject({
      lastAcceptedSharedRevision: expectedSharedRevision + 1,
      lastAcceptedSharedHash: sha256Hex('# Local\n'),
      lastAcceptedLocalHash: sha256Hex('# Local\n'),
      disconnectedCleanly: true,
    });
  });

  it('publishes host use-local resolutions through the local relay host without a local relay service', async () => {
    const { service, conflictId, expectedSharedRevision, expectedSharedHash } = await createConflictFixture();
    const verifySharedState = vi.fn(async () => undefined);
    const publishResolvedState = vi.fn(async (_input: { yjsState: Uint8Array; sharedHash: string }) => ({
      sharedRevision: expectedSharedRevision + 1,
      sharedHash: sha256Hex('# Local\n'),
      hostSessionId: 'host_1',
    }));
    const relayRoomId = service.getCurrentConflict()!.relayRoomId;
    const app = createHttpApp(createLocalOnlyPool(), createUnavailableLiveMarkdownWriter(), {
      localFileService: service,
      localDaemonToken: 'local-secret',
      localMode: true,
      localRelayHost: {
        relayRoomId,
        resumeHosted: vi.fn(async () => true),
        ensureHosted: vi.fn(async () => ({ relayRoomId, hostSessionId: 'host_1' })),
        start: vi.fn(async () => undefined),
        stop: vi.fn(),
        createLink: vi.fn(async () => {
          throw new Error('unexpected_create_link');
        }),
        shareState: vi.fn(async () => ({
          mode: 'relay-host' as const,
          localPath: service.getSummary().absolutePath,
          relayRoomId,
          hostOnline: true,
          hostSessionId: 'host_1',
          sharedRevision: expectedSharedRevision,
          lastSharedHash: expectedSharedHash,
          links: [],
          sessions: [],
        })),
        verifySharedState,
        publishResolvedState,
        revokeLink: vi.fn(async () => undefined),
      },
      applyCollabDocumentState: vi.fn(async () => undefined),
    });

    const response = await request(app)
      .post(`/api/local/conflicts/${conflictId}/use-local`)
      .set('Authorization', 'Bearer local-secret')
      .send({ expectedSharedRevision, expectedSharedHash })
      .expect(200);

    expect(response.body).toMatchObject({
      conflictId,
      status: 'resolved',
      hash: sha256Hex('# Local\n'),
      sharedRevision: expectedSharedRevision + 1,
    });
    expect(verifySharedState).toHaveBeenCalledWith({ expectedSharedRevision, expectedSharedHash });
    expect(publishResolvedState).toHaveBeenCalledWith(expect.objectContaining({
      expectedSharedRevision,
      expectedSharedHash,
      sharedHash: sha256Hex('# Local\n'),
      relayRoomId,
    }));
  });

  it('returns host_offline instead of internal_error when conflict publish socket drops', async () => {
    const { service, conflictId, expectedSharedRevision, expectedSharedHash } = await createConflictFixture();
    const app = createHttpApp(createLocalOnlyPool(), createUnavailableLiveMarkdownWriter(), {
      localFileService: service,
      localDaemonToken: 'local-secret',
      localMode: true,
      localRelayMirror: {
        start: vi.fn(async () => undefined),
        stop: vi.fn(),
        shareState: vi.fn(async () => ({
          mode: 'relay-mirror' as const,
          localPath: service.getSummary().absolutePath,
          relayRoomId: service.getCurrentConflict()!.relayRoomId,
          hostOnline: true,
          hostSessionId: 'host_1',
          sharedRevision: expectedSharedRevision,
          lastSharedHash: expectedSharedHash,
          links: [],
          sessions: [],
        })),
        verifySharedState: vi.fn(async () => undefined),
        publishResolvedState: vi.fn(async () => {
          throw new Error('relay_mirror_publish_closed');
        }),
      },
      applyCollabDocumentState: vi.fn(async () => undefined),
    });

    const response = await request(app)
      .post(`/api/local/conflicts/${conflictId}/use-local`)
      .set('Authorization', 'Bearer local-secret')
      .send({ expectedSharedRevision, expectedSharedHash })
      .expect(409);

    expect(response.body).toEqual({ error: 'host_offline' });
    expect(service.getCurrentConflict()).toMatchObject({ conflictId, status: 'open' });
  });

  it('rejects host conflict resolution when the host controller is attached to a different relay room', async () => {
    const { service, conflictId, expectedSharedRevision, expectedSharedHash } = await createConflictFixture();
    const conflictRelayRoomId = service.getCurrentConflict()!.relayRoomId;
    const publishResolvedState = vi.fn(async () => ({
      sharedRevision: expectedSharedRevision + 1,
      sharedHash: sha256Hex('# Local\n'),
      hostSessionId: 'host_1',
    }));
    const app = createHttpApp(createLocalOnlyPool(), createUnavailableLiveMarkdownWriter(), {
      localFileService: service,
      localDaemonToken: 'local-secret',
      localMode: true,
      localRelayHost: {
        relayRoomId: 'relay_other',
        resumeHosted: vi.fn(async () => true),
        ensureHosted: vi.fn(async () => ({ relayRoomId: 'relay_other', hostSessionId: 'host_1' })),
        start: vi.fn(async () => undefined),
        stop: vi.fn(),
        createLink: vi.fn(async () => {
          throw new Error('unexpected_create_link');
        }),
        shareState: vi.fn(async () => ({
          mode: 'relay-host' as const,
          localPath: service.getSummary().absolutePath,
          relayRoomId: 'relay_other',
          hostOnline: true,
          hostSessionId: 'host_1',
          sharedRevision: expectedSharedRevision,
          lastSharedHash: expectedSharedHash,
          links: [],
          sessions: [],
        })),
        verifySharedState: vi.fn(async () => undefined),
        publishResolvedState,
        revokeLink: vi.fn(async () => undefined),
      },
      applyCollabDocumentState: vi.fn(async () => undefined),
    });

    const response = await request(app)
      .post(`/api/local/conflicts/${conflictId}/use-local`)
      .set('Authorization', 'Bearer local-secret')
      .send({ expectedSharedRevision, expectedSharedHash })
      .expect(403);

    expect(response.body).toEqual({ error: 'forbidden' });
    expect(service.getCurrentConflict()).toMatchObject({ relayRoomId: conflictRelayRoomId, status: 'open' });
    expect(publishResolvedState).not.toHaveBeenCalled();
  });

  it('returns stale_conflict_shared_state before mutating local state when mirror shared state changed', async () => {
    const { service, conflictId, expectedSharedRevision, expectedSharedHash, file } = await createConflictFixture();
    const app = createHttpApp(createLocalOnlyPool(), createUnavailableLiveMarkdownWriter(), {
      localFileService: service,
      localDaemonToken: 'local-secret',
      localMode: true,
      localRelayMirror: {
        start: vi.fn(async () => undefined),
        stop: vi.fn(),
        shareState: vi.fn(async () => ({
          mode: 'relay-mirror' as const,
          localPath: service.getSummary().absolutePath,
          relayRoomId: service.getCurrentConflict()!.relayRoomId,
          hostOnline: true,
          hostSessionId: 'host_1',
          sharedRevision: expectedSharedRevision + 1,
          lastSharedHash: 'sha256:advanced',
          links: [],
          sessions: [],
        })),
        verifySharedState: vi.fn(async () => {
          throw new Error('stale_conflict_shared_state');
        }),
        publishResolvedState: vi.fn(async () => {
          throw new Error('unexpected_publish');
        }),
      },
      applyCollabDocumentState: vi.fn(async () => undefined),
    });

    const response = await request(app)
      .post(`/api/local/conflicts/${conflictId}/use-local`)
      .set('Authorization', 'Bearer local-secret')
      .send({ expectedSharedRevision, expectedSharedHash })
      .expect(409);

    expect(response.body).toEqual({ error: 'stale_conflict_shared_state' });
    expect(await readFile(file, 'utf8')).toBe('# Local\n');
    expect(service.getCurrentConflict()?.status).toBe('open');
  });

  it('does not publish twice when use-local is repeated after resolution', async () => {
    const { service, relayService, conflictId, expectedSharedRevision, expectedSharedHash } = await createConflictFixture();
    const publishSpy = vi.spyOn(relayService, 'acceptSharedState');
    const app = createHttpApp(createLocalOnlyPool(), createUnavailableLiveMarkdownWriter(), {
      localFileService: service,
      localDaemonToken: 'local-secret',
      localMode: true,
      relayService,
      applyCollabDocumentState: vi.fn(async () => undefined),
    });

    const first = await request(app)
      .post(`/api/local/conflicts/${conflictId}/use-local`)
      .set('Authorization', 'Bearer local-secret')
      .send({ expectedSharedRevision, expectedSharedHash })
      .expect(200);

    expect(first.body).toMatchObject({
      conflictId,
      status: 'resolved',
      hash: sha256Hex('# Local\n'),
      sharedRevision: expectedSharedRevision + 1,
    });
    expect(publishSpy).toHaveBeenCalledTimes(1);

    const second = await request(app)
      .post(`/api/local/conflicts/${conflictId}/use-local`)
      .set('Authorization', 'Bearer local-secret')
      .send({ expectedSharedRevision, expectedSharedHash })
      .expect(409);

    expect(second.body).toMatchObject({
      error: 'conflict_already_resolved',
      conflictId,
      status: 'resolved',
      hash: sha256Hex('# Local\n'),
      sharedRevision: expectedSharedRevision + 1,
    });
    expect(publishSpy).toHaveBeenCalledTimes(1);
  });

  it('writes shared markdown to disk and records resolution snapshots for use-shared', async () => {
    const { service, relayService, conflictId, expectedSharedRevision, expectedSharedHash, file } = await createConflictFixture();
    const app = createHttpApp(createLocalOnlyPool(), createUnavailableLiveMarkdownWriter(), {
      localFileService: service,
      localDaemonToken: 'local-secret',
      localMode: true,
      relayService,
      applyCollabDocumentState: vi.fn(async () => undefined),
    });

    const response = await request(app)
      .post(`/api/local/conflicts/${conflictId}/use-shared`)
      .set('Authorization', 'Bearer local-secret')
      .send({ expectedSharedRevision, expectedSharedHash })
      .expect(200);

    expect(response.body).toMatchObject({
      conflictId,
      status: 'resolved',
      hash: sha256Hex('# Shared\n'),
    });
    expect(await readFile(file, 'utf8')).toBe('# Shared\n');
    expect(service.getCurrentConflict()).toBeNull();
    const historical = await request(app)
      .get(`/api/local/conflicts/${conflictId}`)
      .set('Authorization', 'Bearer local-secret')
      .expect(200);
    expect(historical.body.conflict).toMatchObject({
      conflictId,
      status: 'resolved',
      localMarkdown: '# Local\n',
      sharedMarkdown: '# Shared\n',
    });
    expect(service.listVersions().map((version) => version.operation)).toEqual(
      expect.arrayContaining(['conflict_opened', 'conflict_recovery', 'conflict_resolved']),
    );
  });
});
