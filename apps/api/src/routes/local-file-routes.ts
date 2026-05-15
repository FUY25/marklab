import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { HttpAppOptions } from '../http/app';
import type { LocalFileService } from '../local/local-file-service';

type HeaderValue = string | string[] | undefined;

const restoreLocalVersionSchema = z.object({
  versionId: z.string().min(1),
});

const createLocalRelayGrantSchema = z.object({
  role: z.enum(['view', 'edit']),
});

function sendLocalFileMissing(res: Response): void {
  res.status(404).json({ error: 'local_file_not_configured' });
}

function requireLocalFileService(service: LocalFileService | undefined, res: Response): LocalFileService | null {
  if (service) return service;
  sendLocalFileMissing(res);
  return null;
}

function bearerToken(req: Request): string | null {
  const match = /^Bearer\s+(.+)$/iu.exec(req.header('authorization') ?? '');
  return match?.[1] ?? null;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[/u, '').replace(/\]$/u, '').toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function firstHeaderValue(value: HeaderValue): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isLoopbackHostHeader(value: HeaderValue): boolean {
  const header = firstHeaderValue(value);
  if (!header) return true;
  const host = header.startsWith('[') ? header.slice(1, header.indexOf(']')) : header.split(':')[0];
  return host ? isLoopbackHostname(host) : false;
}

function isLoopbackOrigin(value: HeaderValue): boolean {
  const header = firstHeaderValue(value);
  if (!header) return true;
  try {
    return isLoopbackHostname(new URL(header).hostname);
  } catch {
    return false;
  }
}

export function isLoopbackLocalRequest(headers: { host?: HeaderValue; origin?: HeaderValue }): boolean {
  return isLoopbackHostHeader(headers.host) && isLoopbackOrigin(headers.origin);
}

export function createLocalTokenGuard(options: HttpAppOptions) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!isLoopbackLocalRequest(req.headers)) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }

    if (!options.localDaemonToken) {
      res.status(503).json({ error: 'local_token_not_configured' });
      return;
    }

    if (bearerToken(req) !== options.localDaemonToken) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }

    next();
  };
}

async function readLocalShareState(service: LocalFileService, options: HttpAppOptions) {
  if (options.localRelayHost) return await options.localRelayHost.shareState();
  if (options.localRelayMirror) return await options.localRelayMirror.shareState();

  return {
    localPath: service.getSummary().absolutePath,
    relayRoomId: null,
    hostOnline: false,
    hostSessionId: null,
    sharedRevision: null,
    lastSharedHash: null,
    links: [],
    sessions: [],
  };
}

export function createLocalFileRoutes(localFileService: LocalFileService | undefined, options: HttpAppOptions = {}) {
  const router = Router();
  if (localFileService) router.use('/local', createLocalTokenGuard(options));

  router.get('/local/document', (_req: Request, res: Response) => {
    const service = requireLocalFileService(localFileService, res);
    if (!service) return;
    res.json(service.getSummary());
  });

  router.get('/local/app-context', async (_req: Request, res: Response, next: NextFunction) => {
    const service = requireLocalFileService(localFileService, res);
    if (!service) return;

    try {
      const document = service.getSummary();
      res.json({
        document,
        versions: service.listVersions(),
        conflict: document.conflict,
        shareState: await readLocalShareState(service, options),
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/local/flush', async (_req: Request, res: Response, next: NextFunction) => {
    const service = requireLocalFileService(localFileService, res);
    if (!service) return;

    try {
      if (service.getCurrentConflict()) throw new Error('conflict_required');
      await options.flushCollabDocument?.(service.roomName);
      res.json(service.getSummary());
    } catch (error) {
      next(error);
    }
  });

  router.get('/local/versions', (_req: Request, res: Response) => {
    const service = requireLocalFileService(localFileService, res);
    if (!service) return;
    res.json({ versions: service.listVersions() });
  });

  router.get('/local/versions/:versionId', (req: Request, res: Response, next: NextFunction) => {
    const service = requireLocalFileService(localFileService, res);
    if (!service) return;

    try {
      const versionId = req.params.versionId;
      if (typeof versionId !== 'string' || !versionId) throw new Error('missing_route_param:versionId');
      res.json(service.getVersion(versionId));
    } catch (error) {
      next(error);
    }
  });

  router.post('/local/versions/manual-save', async (req: Request, res: Response, next: NextFunction) => {
    const service = requireLocalFileService(localFileService, res);
    if (!service) return;

    try {
      if (service.getCurrentConflict()) throw new Error('conflict_required');
      await options.flushCollabDocument?.(service.roomName);
      const body = z
        .object({
          source: z.enum(['agent', 'user', 'system']).optional(),
          message: z.string().trim().min(1).optional(),
        })
        .optional()
        .parse(req.body);
      const versionInput: { source?: 'agent' | 'user' | 'system'; message?: string | null } = {};
      if (body?.source) versionInput.source = body.source;
      if (body?.message) versionInput.message = body.message;
      res.json(await service.createManualVersion(versionInput));
    } catch (error) {
      next(error);
    }
  });

  router.post('/local/restore', async (req: Request, res: Response, next: NextFunction) => {
    const service = requireLocalFileService(localFileService, res);
    if (!service) return;

    try {
      const input = restoreLocalVersionSchema.parse(req.body);
      if (service.getCurrentConflict()) throw new Error('conflict_required');
      await options.flushCollabDocument?.(service.roomName);
      const restored = await service.restoreVersion(input.versionId);
      await options.applyCollabDocumentState?.(service.roomName, restored.yjsState);
      res.json({
        versionId: restored.versionId,
        versionNumber: restored.versionNumber,
        hash: restored.hash,
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/local/share-state', async (_req: Request, res: Response, next: NextFunction) => {
    const service = requireLocalFileService(localFileService, res);
    if (!service) return;

    try {
      res.json(await readLocalShareState(service, options));
    } catch (error) {
      next(error);
    }
  });

  router.post('/local/sharing', async (_req: Request, res: Response, next: NextFunction) => {
    const service = requireLocalFileService(localFileService, res);
    if (!service) return;

    try {
      if (!options.localRelayHost) throw new Error('relay_service_not_configured');
      await options.localRelayHost.ensureHosted();
      res.json(await readLocalShareState(service, options));
    } catch (error) {
      next(error);
    }
  });

  router.post('/local/access-grants', async (req: Request, res: Response, next: NextFunction) => {
    const service = requireLocalFileService(localFileService, res);
    if (!service) return;

    try {
      if (!options.localRelayHost) throw new Error('relay_service_not_configured');
      const body = createLocalRelayGrantSchema.parse(req.body);
      const grant = await options.localRelayHost.createLink(body.role);
      res.status(201).json(grant);
    } catch (error) {
      next(error);
    }
  });

  router.delete('/local/access-grants/:grantId', async (req: Request, res: Response, next: NextFunction) => {
    const service = requireLocalFileService(localFileService, res);
    if (!service) return;

    try {
      if (!options.localRelayHost) throw new Error('relay_service_not_configured');
      const grantId = req.params.grantId;
      if (typeof grantId !== 'string' || !grantId) throw new Error('missing_route_param:grantId');
      await options.localRelayHost.revokeLink(grantId);
      options.relayServer?.disconnectGrant(grantId);
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.post('/local/shutdown', async (_req: Request, res: Response, next: NextFunction) => {
    const service = requireLocalFileService(localFileService, res);
    if (!service) return;

    try {
      if (!service.getCurrentConflict()) await options.flushCollabDocument?.(service.roomName);
      service.stopWatcher();
      res.json({ ok: true });
      setTimeout(() => {
        process.kill(process.pid, 'SIGTERM');
      }, 25).unref();
    } catch (error) {
      next(error);
    }
  });

  return router;
}
