import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { toRoomName } from '../collab/persistence';
import type { DbPool } from '../db/client';
import type { HttpAppOptions } from '../http/app';
import { readBranchState } from '../services/doc-read';
import { restoreVersionToBranchState } from '../services/editor-state';
import type { LiveMarkdownWriter } from '../services/live-writer';
import { branchFromVersion, getDocumentSummary, listBranches, listVersions, showVersion } from '../services/version-service';

const branchSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1).optional(),
});

const restoreSchema = z.object({
  versionId: z.string().min(1),
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

export function createVersionRoutes(pool: DbPool, liveWriter: LiveMarkdownWriter, options: HttpAppOptions = {}) {
  const router = Router();

  router.get('/docs/:docId', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const docId = requiredParam(req, 'docId');
      const [doc, branches] = await Promise.all([getDocumentSummary(pool, docId), listBranches(pool, docId)]);
      res.json({ ...doc, branches });
    } catch (error) {
      next(error);
    }
  });

  router.get('/docs/:docId/branches', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const docId = requiredParam(req, 'docId');
      await getDocumentSummary(pool, docId);
      res.json({ branches: await listBranches(pool, docId) });
    } catch (error) {
      next(error);
    }
  });

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

  router.post('/docs/:docId/branches/:branchId/restore', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const docId = requiredParam(req, 'docId');
      const branchId = requiredParam(req, 'branchId');
      const body = restoreSchema.parse(req.body);
      await options.flushCollabDocument?.(toRoomName(docId, branchId));
      await readBranchState(pool, docId, branchId);
      const applied = await restoreVersionToBranchState({
        pool,
        liveWriter,
        docId,
        branchId,
        versionId: body.versionId,
      });
      res.json({ versionId: applied.versionId, versionNumber: applied.versionNumber, hash: applied.hash });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
