import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { DbPool } from '../db/client';
import { branchFromVersion, listVersions, showVersion } from '../services/version-service';

const branchSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1).optional(),
});

function requiredParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || !value) throw new Error(`missing_route_param:${name}`);
  return value;
}

function slugifyBranchName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-|-$/gu, '')
    .slice(0, 80) || 'branch';
}

export function createVersionRoutes(pool: DbPool) {
  const router = Router();

  router.get('/docs/:docId/branches/:branchId/versions', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const docId = requiredParam(req, 'docId');
      const branchId = requiredParam(req, 'branchId');
      res.json({ versions: await listVersions(pool, docId, branchId) });
    } catch (error) {
      next(error);
    }
  });

  router.get('/docs/:docId/versions/:versionId', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const docId = requiredParam(req, 'docId');
      const versionId = requiredParam(req, 'versionId');
      res.json(await showVersion(pool, docId, versionId));
    } catch (error) {
      next(error);
    }
  });

  router.post('/docs/:docId/versions/:versionId/branch', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const docId = requiredParam(req, 'docId');
      const versionId = requiredParam(req, 'versionId');
      const body = branchSchema.parse(req.body);
      const result = await branchFromVersion(
        pool,
        docId,
        versionId,
        body.name,
        body.slug ?? slugifyBranchName(body.name),
      );
      res.status(201).json({ branchId: result.branchId, headVersionId: result.versionId });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
