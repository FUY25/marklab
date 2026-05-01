import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { HttpAppOptions } from '../http/app';
import type { LocalFileService } from '../local/local-file-service';

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

export function createLocalFileRoutes(localFileService: LocalFileService | undefined, options: HttpAppOptions = {}) {
  const router = Router();

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
      res.json(service.createManualVersion());
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

  return router;
}
