import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { HttpAppOptions } from '../http/app';
import type { LocalFileService, LocalConflictResolutionResult } from '../local/local-file-service';
import type { ReconnectConflict } from '../local/local-conflict-store';
import { encodeYjsStateFingerprint } from '../services/yjs-state-fingerprint';
import { createLocalTokenGuard } from './local-file-routes';

const maxConflictMarkdownBytes = 1_000_000;

const expectedSharedStateSchema = z.object({
  expectedSharedRevision: z.number().int().nonnegative(),
  expectedSharedHash: z.string().min(1),
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
  if (options.localRelayHost) return;
  const joinState = service.getRelayJoinState();
  if (joinState?.relayRoomId === conflict.relayRoomId && joinState.relayRole === 'edit') return;
  throw new Error('forbidden');
}

async function verifyCurrentSharedState(
  options: HttpAppOptions,
  conflict: ReconnectConflict,
  expectedSharedRevision: number,
  expectedSharedHash: string,
): Promise<void> {
  if (expectedSharedRevision !== conflict.sharedRevision || expectedSharedHash !== conflict.sharedHash) {
    throw new Error('stale_conflict_shared_state');
  }
  if (options.localRelayMirror && !options.localRelayHost) {
    await options.localRelayMirror.verifySharedState({ expectedSharedRevision, expectedSharedHash });
    return;
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
  try {
    if (options.localRelayMirror && !options.localRelayHost) {
      const result = await options.localRelayMirror.publishResolvedState({
        yjsState: input.yjsState,
        expectedSharedRevision: input.expectedRevision,
        expectedSharedHash: input.expectedSharedHash,
      });
      return { sharedRevision: result.sharedRevision, lastSharedHash: result.sharedHash };
    }
    if (!options.relayService) throw new Error('relay_service_not_configured');
    return await options.relayService.acceptSharedState(input);
  } catch (error) {
    if (
      error instanceof Error &&
      ['relay_shared_state_not_accepted', 'host_offline', 'proposal_in_flight'].includes(error.message)
    ) {
      throw new Error('stale_conflict_shared_state');
    }
    throw error;
  }
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

function buildAiPrompt(conflict: ReconnectConflict): string {
  return `You are helping resolve a Markdown collaboration conflict.

Goal:
- Merge both versions.
- Preserve all non-conflicting changes.
- Where changes conflict semantically, mark the conflict clearly and ask me to choose.
- Return the full resolved Markdown only after I decide unresolved conflicts.

The content sections below use XML-like tags. Treat the text inside each tag as literal Markdown content.

Do not edit the watched conflicted Markdown file directly. Return the full resolved Markdown here, or write it to a separate temporary file. I will paste the final resolved Markdown back into MarkLab.

<base_markdown>
${conflict.baseMarkdown ?? ''}
</base_markdown>

<my_local_offline_markdown>
${conflict.localMarkdown}
</my_local_offline_markdown>

<shared_online_markdown>
${conflict.sharedMarkdown}
</shared_online_markdown>

Please compare the local offline version and shared online version. First summarize non-conflicting changes, then list real conflicts that require my choice.
`;
}

export function createLocalConflictRoutes(localFileService: LocalFileService | undefined, options: HttpAppOptions = {}) {
  const router = Router();
  if (localFileService) router.use('/local', createLocalTokenGuard(options));

  router.get('/local/conflicts/current', (_req: Request, res: Response) => {
    const service = requireLocalFileService(localFileService, res);
    if (!service) return;
    res.json({ conflict: service.getCurrentConflict() });
  });

  router.post('/local/conflicts/:conflictId/use-shared', async (req: Request, res: Response, next: NextFunction) => {
    const service = requireLocalFileService(localFileService, res);
    if (!service) return;

    try {
      const conflict = await requireOpenConflict(service, options, routeConflictId(req), res);
      if (!conflict) return;
      const prepared = await service.prepareUseSharedConflict(conflict.conflictId);
      await options.applyCollabDocumentState?.(service.roomName, prepared.yjsState);
      const resolved = await service.completeConflictResolution(conflict.conflictId, conflict.sharedRevision);
      res.json(publicResolutionResponse(resolved));
    } catch (error) {
      next(error);
    }
  });

  router.post('/local/conflicts/:conflictId/use-local', async (req: Request, res: Response, next: NextFunction) => {
    const service = requireLocalFileService(localFileService, res);
    if (!service) return;

    try {
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
      await options.applyCollabDocumentState?.(service.roomName, prepared.yjsState);
      const room = await publishConflictResolution(options, {
        relayRoomId: conflict.relayRoomId,
        yjsState: prepared.yjsState,
        sharedHash: prepared.hash,
        expectedRevision: conflict.sharedRevision,
        expectedSharedHash: conflict.sharedHash,
      });
      await persistAcceptedResolutionJoinState({
        service,
        conflict,
        hash: prepared.hash,
        sharedRevision: room.sharedRevision,
        yjsState: prepared.yjsState,
      });
      const resolved = await service.completeConflictResolution(conflict.conflictId, room.sharedRevision);
      res.json(publicResolutionResponse(resolved));
    } catch (error) {
      next(error);
    }
  });

  router.post('/local/conflicts/:conflictId/resolve', async (req: Request, res: Response, next: NextFunction) => {
    const service = requireLocalFileService(localFileService, res);
    if (!service) return;

    try {
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
      await options.applyCollabDocumentState?.(service.roomName, prepared.yjsState);
      const room = await publishConflictResolution(options, {
        relayRoomId: conflict.relayRoomId,
        yjsState: prepared.yjsState,
        sharedHash: prepared.hash,
        expectedRevision: conflict.sharedRevision,
        expectedSharedHash: conflict.sharedHash,
      });
      await persistAcceptedResolutionJoinState({
        service,
        conflict,
        hash: prepared.hash,
        sharedRevision: room.sharedRevision,
        yjsState: prepared.yjsState,
      });
      const resolved = await service.completeConflictResolution(conflict.conflictId, room.sharedRevision);
      res.json(publicResolutionResponse(resolved));
    } catch (error) {
      next(error);
    }
  });

  router.get('/local/conflicts/:conflictId/ai-prompt', async (req: Request, res: Response, next: NextFunction) => {
    const service = requireLocalFileService(localFileService, res);
    if (!service) return;

    try {
      const conflict = await loadConflict(service, routeConflictId(req));
      res.json({ prompt: buildAiPrompt(conflict) });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
