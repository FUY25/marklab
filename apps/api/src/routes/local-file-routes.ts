import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { HttpAppOptions } from '../http/app';
import type { LocalFileService } from '../local/local-file-service';

type HeaderValue = string | string[] | undefined;

const restoreLocalVersionSchema = z.object({
  versionId: z.string().min(1),
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

function createLocalTokenGuard(options: HttpAppOptions) {
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

export function createLocalFileRoutes(localFileService: LocalFileService | undefined, options: HttpAppOptions = {}) {
  const router = Router();
  if (localFileService) router.use('/local', createLocalTokenGuard(options));

  router.get('/local/document', (_req: Request, res: Response) => {
    const service = requireLocalFileService(localFileService, res);
    if (!service) return;
    res.json(service.getSummary());
  });

  router.post('/local/flush', async (_req: Request, res: Response, next: NextFunction) => {
    const service = requireLocalFileService(localFileService, res);
    if (!service) return;

    try {
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

  router.post('/local/versions/manual-save', async (_req: Request, res: Response, next: NextFunction) => {
    const service = requireLocalFileService(localFileService, res);
    if (!service) return;

    try {
      await options.flushCollabDocument?.(service.roomName);
      res.json(await service.createManualVersion());
    } catch (error) {
      next(error);
    }
  });

  router.post('/local/restore', async (req: Request, res: Response, next: NextFunction) => {
    const service = requireLocalFileService(localFileService, res);
    if (!service) return;

    try {
      const input = restoreLocalVersionSchema.parse(req.body);
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

  router.post('/local/shutdown', async (_req: Request, res: Response, next: NextFunction) => {
    const service = requireLocalFileService(localFileService, res);
    if (!service) return;

    try {
      await options.flushCollabDocument?.(service.roomName);
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
