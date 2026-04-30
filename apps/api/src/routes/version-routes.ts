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

function authRequired(): boolean {
  return process.env.MARKLAB_REQUIRE_AUTH === 'true';
}

export function createVersionRoutes(pool: DbPool, liveWriter: LiveMarkdownWriter, options: HttpAppOptions = {}) {
  const router = Router();

  router.get('/docs/:docId', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const docId = requiredParam(req, 'docId');
      const doc = await getDocumentSummary(pool, docId);
      if (doc.defaultBranchId) await options.auth?.requireDocumentAccess(req, docId, doc.defaultBranchId, 'read');
      else if (authRequired()) throw new Error('forbidden');
      const branches = await listBranches(pool, docId);
      res.json({ ...doc, branches });
    } catch (error) {
      next(error);
    }
  });

  router.get('/docs/:docId/branches', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const docId = requiredParam(req, 'docId');
      const doc = await getDocumentSummary(pool, docId);
      if (doc.defaultBranchId) await options.auth?.requireDocumentAccess(req, docId, doc.defaultBranchId, 'read');
      else if (authRequired()) throw new Error('forbidden');
      res.json({ branches: await listBranches(pool, docId) });
    } catch (error) {
      next(error);
    }
  });

  router.get('/docs/:docId/branches/:branchId/versions', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const docId = requiredParam(req, 'docId');
      const branchId = requiredParam(req, 'branchId');
      await options.auth?.requireDocumentAccess(req, docId, branchId, 'read');
      res.json({ versions: await listVersions(pool, docId, branchId) });
    } catch (error) {
      next(error);
    }
  });

  router.get('/docs/:docId/versions/:versionId', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const docId = requiredParam(req, 'docId');
      const versionId = requiredParam(req, 'versionId');
      const version = await showVersion(pool, docId, versionId);
      await options.auth?.requireDocumentAccess(req, docId, version.branchId, 'read');
      res.json(version);
    } catch (error) {
      next(error);
    }
  });

  router.post('/docs/:docId/versions/:versionId/branch', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const docId = requiredParam(req, 'docId');
      const versionId = requiredParam(req, 'versionId');
      if (authRequired()) {
        const sourceVersion = await showVersion(pool, docId, versionId);
        await options.auth?.requireDocumentAccess(req, docId, sourceVersion.branchId, 'write');
      }
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
      await options.auth?.requireDocumentAccess(req, docId, branchId, 'write');
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
