import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
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

  it('generates an AI prompt that preserves fenced Markdown literally', async () => {
    const localMarkdown = '# Local\n\n```ts\nconst answer = \"keep fenced code\";\n```\n';
    const { conflictId, service } = await createConflictFixture({ localMarkdown });
    const app = createHttpApp(createLocalOnlyPool(), createUnavailableLiveMarkdownWriter(), {
      localFileService: service,
      localDaemonToken: 'local-secret',
      localMode: true,
    });

    const response = await request(app)
      .get(`/api/local/conflicts/${conflictId}/ai-prompt`)
      .set('Authorization', 'Bearer local-secret')
      .expect(200);

    expect(response.body.prompt).toContain('<base_markdown>\n# Base\n\n</base_markdown>');
    expect(response.body.prompt).toContain('<my_local_offline_markdown>\n# Local\n\n```ts\nconst answer = "keep fenced code";\n```\n\n</my_local_offline_markdown>');
    expect(response.body.prompt).toContain('<shared_online_markdown>\n# Shared\n\n</shared_online_markdown>');
    expect(response.body.prompt).toContain('Do not edit the watched conflicted Markdown file directly.');
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
});
