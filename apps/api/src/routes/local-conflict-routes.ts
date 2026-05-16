import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { HttpAppOptions } from '../http/app';
import type {
  LocalFileService,
  LocalConflictResolutionResult,
  PreparedLocalConflictResolution,
} from '../local/local-file-service';
import type { ReconnectConflict } from '../local/local-conflict-store';
import { encodeYjsStateFingerprint } from '../services/yjs-state-fingerprint';
import { createLocalTokenGuard } from './local-file-routes';

const maxConflictMarkdownBytes = 1_000_000;

const expectedSharedStateSchema = z.object({
  expectedSharedRevision: z.number().int().nonnegative(),
  expectedSharedHash: z.string(),
});

const resolveConflictSchema = expectedSharedStateSchema.extend({
  markdown: z.string(),
});

function sendLocalFileMissing(res: Response): void {
  res.status(404).json({ error: 'local_file_not_configured' });
}

function requireLocalFileService(service: LocalFileService | undefined, res: Response): LocalFileService | null {
  if (service) return service;
  sendLocalFileMissing(res);
  return null;
}

function routeConflictId(req: Request): string {
  const conflictId = req.params.conflictId;
  if (typeof conflictId !== 'string' || !conflictId) throw new Error('missing_route_param:conflictId');
  return conflictId;
}

async function loadConflict(service: LocalFileService, conflictId: string): Promise<ReconnectConflict> {
  const conflict = await service.getConflict(conflictId);
  if (!conflict) throw new Error('conflict_not_found');
  return conflict;
}

function publicResolutionResponse(result: LocalConflictResolutionResult): Omit<LocalConflictResolutionResult, 'yjsState'> {
  return {
    conflictId: result.conflictId,
    status: result.status,
    hash: result.hash,
    sharedRevision: result.sharedRevision,
  };
}

async function resolvedSharedRevision(options: HttpAppOptions, conflict: ReconnectConflict): Promise<number | null> {
  if (options.localRelayHost) {
    try {
      return (await options.localRelayHost.shareState()).sharedRevision ?? conflict.sharedRevision;
    } catch {
      return conflict.sharedRevision;
    }
  }
  if (!options.relayService) return conflict.sharedRevision;
  try {
    return (await options.relayService.getRoom(conflict.relayRoomId)).sharedRevision;
  } catch {
    return conflict.sharedRevision;
  }
}

async function sendAlreadyResolved(
  service: LocalFileService,
  options: HttpAppOptions,
  conflict: ReconnectConflict,
  res: Response,
): Promise<void> {
  res.status(409).json({
    error: 'conflict_already_resolved',
    conflictId: conflict.conflictId,
    status: 'resolved',
    hash: service.getSummary().hash,
    sharedRevision: await resolvedSharedRevision(options, conflict),
  });
}

async function requireOpenConflict(
  service: LocalFileService,
  options: HttpAppOptions,
  conflictId: string,
  res: Response,
): Promise<ReconnectConflict | null> {
  const conflict = await loadConflict(service, conflictId);
  if (conflict.status === 'open') return conflict;
  await sendAlreadyResolved(service, options, conflict, res);
  return null;
}

function requirePublishPermission(service: LocalFileService, options: HttpAppOptions, conflict: ReconnectConflict): void {
  if (options.localRelayHost) {
    if (options.localRelayHost.relayRoomId !== conflict.relayRoomId) throw new Error('forbidden');
    return;
  }
  const joinState = service.getRelayJoinState();
  if (joinState?.relayRoomId === conflict.relayRoomId && joinState.relayRole === 'edit') return;
  throw new Error('forbidden');
}

function conflictExpectedSharedRevision(conflict: ReconnectConflict): number {
  return conflict.expectedSharedRevision ?? conflict.sharedRevision;
}

function conflictExpectedSharedHash(conflict: ReconnectConflict): string {
  return conflict.expectedSharedHash ?? conflict.sharedHash;
}

function assertExpectedConflictSharedState(
  conflict: ReconnectConflict,
  expectedSharedRevision: number,
  expectedSharedHash: string,
): void {
  if (
    expectedSharedRevision !== conflictExpectedSharedRevision(conflict)
    || expectedSharedHash !== conflictExpectedSharedHash(conflict)
  ) {
    throw new Error('stale_conflict_shared_state');
  }
}

function isRelayUnavailableError(error: unknown): boolean {
  return error instanceof Error && [
    'relay_host_publish_timeout',
    'relay_host_publish_closed',
    'relay_mirror_publish_timeout',
    'relay_mirror_publish_closed',
    'relay_mirror_verify_timeout',
    'relay_mirror_verify_closed',
  ].includes(error.message);
}

async function verifyCurrentSharedState(
  options: HttpAppOptions,
  conflict: ReconnectConflict,
  expectedSharedRevision: number,
  expectedSharedHash: string,
): Promise<void> {
  if (
    expectedSharedRevision !== conflictExpectedSharedRevision(conflict)
    || expectedSharedHash !== conflictExpectedSharedHash(conflict)
  ) {
    throw new Error('stale_conflict_shared_state');
  }
  try {
    if (options.localRelayMirror && !options.localRelayHost) {
      await options.localRelayMirror.verifySharedState({ expectedSharedRevision, expectedSharedHash });
      return;
    }
    if (options.localRelayHost) {
      await options.localRelayHost.verifySharedState({ expectedSharedRevision, expectedSharedHash });
      return;
    }
  } catch (error) {
    if (isRelayUnavailableError(error)) throw new Error('host_offline');
    throw error;
  }
  if (!options.relayService) throw new Error('relay_service_not_configured');
  const current = await options.relayService.getRoom(conflict.relayRoomId);
  if (current.sharedRevision !== expectedSharedRevision || (current.lastSharedHash ?? '') !== expectedSharedHash) {
    throw new Error('stale_conflict_shared_state');
  }
}

async function publishConflictResolution(
  options: HttpAppOptions,
  input: {
    relayRoomId: string;
    yjsState: Uint8Array;
    sharedHash: string;
    expectedRevision: number;
    expectedSharedHash: string;
  },
): Promise<{ sharedRevision: number; lastSharedHash: string | null }> {
  function requireExpectedPublishedHash(result: { sharedRevision: number; lastSharedHash: string | null }) {
    if ((result.lastSharedHash ?? '') !== input.sharedHash) throw new Error('relay_shared_state_not_accepted');
    return result;
  }

  try {
    if (options.localRelayMirror && !options.localRelayHost) {
      const result = await options.localRelayMirror.publishResolvedState({
        yjsState: input.yjsState,
        sharedHash: input.sharedHash,
        expectedSharedRevision: input.expectedRevision,
        expectedSharedHash: input.expectedSharedHash,
      });
      return requireExpectedPublishedHash({ sharedRevision: result.sharedRevision, lastSharedHash: result.sharedHash });
    }
    if (options.localRelayHost) {
      if (options.localRelayHost.relayRoomId !== input.relayRoomId) throw new Error('forbidden');
      const result = await options.localRelayHost.publishResolvedState({
        relayRoomId: input.relayRoomId,
        yjsState: input.yjsState,
        sharedHash: input.sharedHash,
        expectedSharedRevision: input.expectedRevision,
        expectedSharedHash: input.expectedSharedHash,
      });
      return requireExpectedPublishedHash({ sharedRevision: result.sharedRevision, lastSharedHash: result.sharedHash });
    }
    if (!options.relayService) throw new Error('relay_service_not_configured');
    return requireExpectedPublishedHash(await options.relayService.acceptSharedState(input));
  } catch (error) {
    if (error instanceof Error && error.message === 'host_offline') throw error;
    if (isRelayUnavailableError(error)) throw new Error('host_offline');
    if (
      error instanceof Error &&
      ['relay_shared_state_not_accepted', 'proposal_in_flight'].includes(error.message)
    ) {
      throw new Error('stale_conflict_shared_state');
    }
    throw error;
  }
}

async function resumeLocalRelayHostAfterSharedResolution(options: HttpAppOptions, conflict: ReconnectConflict): Promise<void> {
  if (!options.localRelayHost) return;
  if (options.localRelayHost.relayRoomId !== conflict.relayRoomId) throw new Error('forbidden');
  if (!(await options.localRelayHost.resumeHosted())) throw new Error('host_offline');
}

function assertMarkdownSize(markdown: string): void {
  if (Buffer.byteLength(markdown, 'utf8') > maxConflictMarkdownBytes) throw new Error('markdown_too_large');
}

async function persistAcceptedResolutionJoinState(input: {
  service: LocalFileService;
  conflict: ReconnectConflict;
  hash: string;
  sharedRevision: number;
  yjsState: Uint8Array;
}): Promise<void> {
  const joinState = input.service.getRelayJoinState();
  if (!joinState || joinState.relayRoomId !== input.conflict.relayRoomId) return;
  await input.service.saveRelayJoinState({
    ...joinState,
    lastAcceptedLocalHash: input.hash,
    lastAcceptedSharedHash: input.hash,
    lastAcceptedSharedRevision: input.sharedRevision,
    lastAcceptedYjsStateBase64: Buffer.from(input.yjsState).toString('base64'),
    lastAcceptedStateFingerprint: encodeYjsStateFingerprint(input.yjsState),
    disconnectedCleanly: true,
    updatedAt: new Date().toISOString(),
  });
}

async function applyPreparedResolutionToActiveProvider(
  options: HttpAppOptions,
  service: LocalFileService,
  conflict: ReconnectConflict,
  prepared: PreparedLocalConflictResolution,
): Promise<PreparedLocalConflictResolution> {
  const appliedYjsState = await options.applyCollabDocumentState?.(service.roomName, prepared.yjsState, {
    expectedCurrentHash: conflict.sharedHash,
  });
  if (!appliedYjsState) return prepared;
  return service.adoptAppliedConflictResolutionState(prepared, appliedYjsState);
}

async function restoreActiveProviderToConflictSharedState(
  options: HttpAppOptions,
  service: LocalFileService,
  conflict: ReconnectConflict,
  expectedCurrentHash: string,
): Promise<void> {
  await options.applyCollabDocumentState?.(
    service.roomName,
    new Uint8Array(Buffer.from(conflict.sharedYjsStateBase64, 'base64')),
    { expectedCurrentHash },
  );
}

async function verifyActiveProviderStillAtConflict(
  options: HttpAppOptions,
  service: LocalFileService,
  conflict: ReconnectConflict,
): Promise<void> {
  await options.verifyCollabDocumentState?.(service.roomName, {
    expectedCurrentHash: conflict.sharedHash,
  });
  options.closeCollabDocumentConnections?.(service.roomName);
}

export function createLocalConflictRoutes(localFileService: LocalFileService | undefined, options: HttpAppOptions = {}) {
  const router = Router();
  const conflictResolutionLocks = new Map<string, Promise<void>>();

  async function withConflictResolutionLock<T>(conflictId: string, operation: () => Promise<T>): Promise<T> {
    const previous = conflictResolutionLocks.get(conflictId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(operation);
    const lock = run.then(() => undefined, () => undefined);
    conflictResolutionLocks.set(conflictId, lock);
    try {
      return await run;
    } finally {
      if (conflictResolutionLocks.get(conflictId) === lock) conflictResolutionLocks.delete(conflictId);
    }
  }
  if (localFileService) router.use('/local', createLocalTokenGuard(options));

  router.get('/local/conflicts/current', (_req: Request, res: Response) => {
    const service = requireLocalFileService(localFileService, res);
    if (!service) return;
    res.json({ conflict: service.getCurrentConflict() });
  });

  router.get('/local/conflicts/:conflictId', async (req: Request, res: Response, next: NextFunction) => {
    const service = requireLocalFileService(localFileService, res);
    if (!service) return;

    try {
      res.json({ conflict: await loadConflict(service, routeConflictId(req)) });
    } catch (error) {
      next(error);
    }
  });

  router.post('/local/conflicts/:conflictId/use-shared', async (req: Request, res: Response, next: NextFunction) => {
    const service = requireLocalFileService(localFileService, res);
    if (!service) return;

    try {
      await withConflictResolutionLock(routeConflictId(req), async () => {
        const conflict = await requireOpenConflict(service, options, routeConflictId(req), res);
        if (!conflict) return;
        const body = expectedSharedStateSchema.parse(req.body);
        assertExpectedConflictSharedState(conflict, body.expectedSharedRevision, body.expectedSharedHash);
        const prepared = await service.prepareUseSharedConflict(conflict.conflictId);
        await service.preflightConflictResolutionLocalCommit(conflict.conflictId);
        await verifyActiveProviderStillAtConflict(options, service, conflict);
        const appliedPrepared = await applyPreparedResolutionToActiveProvider(options, service, conflict, prepared);
        let sharedRevision = conflictExpectedSharedRevision(conflict);
        if (prepared.hash !== conflictExpectedSharedHash(conflict)) {
          requirePublishPermission(service, options, conflict);
          await verifyCurrentSharedState(options, conflict, body.expectedSharedRevision, body.expectedSharedHash);
          try {
            const room = await publishConflictResolution(options, {
              relayRoomId: conflict.relayRoomId,
              yjsState: appliedPrepared.yjsState,
              sharedHash: appliedPrepared.hash,
              expectedRevision: conflictExpectedSharedRevision(conflict),
              expectedSharedHash: conflictExpectedSharedHash(conflict),
            });
            sharedRevision = room.sharedRevision;
          } catch (error) {
            await restoreActiveProviderToConflictSharedState(options, service, conflict, appliedPrepared.hash).catch(() => undefined);
            await service.refreshOpenConflictFromDisk(conflict.conflictId).catch(() => undefined);
            throw error;
          }
        } else {
          let hostWasOffline = false;
          try {
            await verifyCurrentSharedState(options, conflict, body.expectedSharedRevision, body.expectedSharedHash);
          } catch (error) {
            if (!(error instanceof Error && error.message === 'host_offline')) throw error;
            hostWasOffline = true;
          }
          if (hostWasOffline) await resumeLocalRelayHostAfterSharedResolution(options, conflict);
        }
        let resolved: LocalConflictResolutionResult;
        try {
          await service.commitConflictResolutionLocally(conflict.conflictId, appliedPrepared);
          resolved = await service.completeConflictResolution(conflict.conflictId, sharedRevision, appliedPrepared);
        } catch (error) {
          await service.refreshOpenConflictAfterSharedPublish(conflict.conflictId, appliedPrepared, sharedRevision).catch(() => undefined);
          throw error;
        }
        res.json(publicResolutionResponse(resolved));
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/local/conflicts/:conflictId/use-local', async (req: Request, res: Response, next: NextFunction) => {
    const service = requireLocalFileService(localFileService, res);
    if (!service) return;

    try {
      await withConflictResolutionLock(routeConflictId(req), async () => {
        const conflict = await requireOpenConflict(service, options, routeConflictId(req), res);
        if (!conflict) return;
        requirePublishPermission(service, options, conflict);
        const body = expectedSharedStateSchema.parse(req.body);
        await verifyCurrentSharedState(options, conflict, body.expectedSharedRevision, body.expectedSharedHash);
        const prepared = await service.prepareUseLocalConflict(
          conflict.conflictId,
          body.expectedSharedRevision,
          body.expectedSharedHash,
        );
        await service.preflightConflictResolutionLocalCommit(conflict.conflictId);
        await verifyActiveProviderStillAtConflict(options, service, conflict);
        let appliedPrepared = prepared;
        try {
          appliedPrepared = await applyPreparedResolutionToActiveProvider(options, service, conflict, prepared);
        } catch (error) {
          await service.refreshOpenConflictFromDisk(conflict.conflictId).catch(() => undefined);
          throw error;
        }
        let room: Awaited<ReturnType<typeof publishConflictResolution>>;
        try {
          room = await publishConflictResolution(options, {
            relayRoomId: conflict.relayRoomId,
            yjsState: appliedPrepared.yjsState,
            sharedHash: appliedPrepared.hash,
            expectedRevision: conflictExpectedSharedRevision(conflict),
            expectedSharedHash: conflictExpectedSharedHash(conflict),
          });
        } catch (error) {
          await restoreActiveProviderToConflictSharedState(options, service, conflict, appliedPrepared.hash).catch(() => undefined);
          await service.refreshOpenConflictFromDisk(conflict.conflictId).catch(() => undefined);
          throw error;
        }
        try {
          await service.commitConflictResolutionLocally(conflict.conflictId, appliedPrepared);
          const resolved = await service.completeConflictResolution(conflict.conflictId, room.sharedRevision, appliedPrepared);
          await persistAcceptedResolutionJoinState({
            service,
            conflict,
            hash: appliedPrepared.hash,
            sharedRevision: room.sharedRevision,
            yjsState: appliedPrepared.yjsState,
          });
          res.json(publicResolutionResponse(resolved));
        } catch (error) {
          await service.refreshOpenConflictAfterSharedPublish(conflict.conflictId, appliedPrepared, room.sharedRevision).catch(() => undefined);
          throw error;
        }
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/local/conflicts/:conflictId/resolve', async (req: Request, res: Response, next: NextFunction) => {
    const service = requireLocalFileService(localFileService, res);
    if (!service) return;

    try {
      await withConflictResolutionLock(routeConflictId(req), async () => {
        const conflict = await requireOpenConflict(service, options, routeConflictId(req), res);
        if (!conflict) return;
        requirePublishPermission(service, options, conflict);
        const body = resolveConflictSchema.parse(req.body);
        assertMarkdownSize(body.markdown);
        await verifyCurrentSharedState(options, conflict, body.expectedSharedRevision, body.expectedSharedHash);
        const prepared = await service.prepareResolvedConflict(
          conflict.conflictId,
          body.markdown,
          body.expectedSharedRevision,
          body.expectedSharedHash,
        );
        await service.preflightConflictResolutionLocalCommit(conflict.conflictId);
        await verifyActiveProviderStillAtConflict(options, service, conflict);
        let appliedPrepared = prepared;
        try {
          appliedPrepared = await applyPreparedResolutionToActiveProvider(options, service, conflict, prepared);
        } catch (error) {
          await service.refreshOpenConflictFromDisk(conflict.conflictId).catch(() => undefined);
          throw error;
        }
        let room: Awaited<ReturnType<typeof publishConflictResolution>>;
        try {
          room = await publishConflictResolution(options, {
            relayRoomId: conflict.relayRoomId,
            yjsState: appliedPrepared.yjsState,
            sharedHash: appliedPrepared.hash,
            expectedRevision: conflictExpectedSharedRevision(conflict),
            expectedSharedHash: conflictExpectedSharedHash(conflict),
          });
        } catch (error) {
          await restoreActiveProviderToConflictSharedState(options, service, conflict, appliedPrepared.hash).catch(() => undefined);
          await service.refreshOpenConflictFromDisk(conflict.conflictId).catch(() => undefined);
          throw error;
        }
        try {
          await service.commitConflictResolutionLocally(conflict.conflictId, appliedPrepared);
          const resolved = await service.completeConflictResolution(conflict.conflictId, room.sharedRevision, appliedPrepared);
          await persistAcceptedResolutionJoinState({
            service,
            conflict,
            hash: appliedPrepared.hash,
            sharedRevision: room.sharedRevision,
            yjsState: appliedPrepared.yjsState,
          });
          res.json(publicResolutionResponse(resolved));
        } catch (error) {
          await service.refreshOpenConflictAfterSharedPublish(conflict.conflictId, appliedPrepared, room.sharedRevision).catch(() => undefined);
          throw error;
        }
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
