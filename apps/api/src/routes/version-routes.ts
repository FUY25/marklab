import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { toRoomName } from '../collab/persistence';
import type { DbPool } from '../db/client';
import type { HttpAppOptions } from '../http/app';
import { readBranchState } from '../services/doc-read';
import { restoreVersionToBranchState } from '../services/editor-state';
import type { LiveMarkdownWriter } from '../services/live-writer';
import { flushBranchMarkdownMirror } from '../services/milkdown-transformer';
import type { VerifiedDocumentAccess } from '../services/access-control';
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

function isBranchScopedAccess(access: VerifiedDocumentAccess | void): boolean {
  return Boolean(access?.grantId);
}

export function createVersionRoutes(pool: DbPool, liveWriter: LiveMarkdownWriter, options: HttpAppOptions = {}) {
  const router = Router();

  router.get('/docs/:docId', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const docId = requiredParam(req, 'docId');
      const doc = await getDocumentSummary(pool, docId);
      let access: VerifiedDocumentAccess | void = undefined;
      if (doc.defaultBranchId) access = await options.auth?.requireDocumentAccess(req, docId, doc.defaultBranchId, 'read');
      else if (authRequired()) throw new Error('forbidden');
      const branches = await listBranches(pool, docId);
      res.json({
        ...doc,
        branches: isBranchScopedAccess(access)
          ? branches.filter((branch) => branch.branchId === doc.defaultBranchId)
          : branches,
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/docs/:docId/branches', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const docId = requiredParam(req, 'docId');
      const doc = await getDocumentSummary(pool, docId);
      if (doc.defaultBranchId) {
        const access = await options.auth?.requireDocumentAccess(req, docId, doc.defaultBranchId, 'read');
        if (isBranchScopedAccess(access)) throw new Error('forbidden');
      }
      else if (authRequired()) throw new Error('forbidden');
      res.json({ branches: await listBranches(pool, docId) });
    } catch (error) {
      next(error);
    }
  });

  router.get('/docs/:docId/branches/:branchId/summary', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const docId = requiredParam(req, 'docId');
      const branchId = requiredParam(req, 'branchId');
      const readAccess = await options.auth?.requireDocumentAccess(req, docId, branchId, 'read');
      let canWrite = false;
      try {
        await options.auth?.requireDocumentAccess(req, docId, branchId, 'write');
        canWrite = true;
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'forbidden') throw error;
      }

      const result = await pool.query<{
        doc_id: string;
        branch_id: string;
        title: string;
        branch_name: string;
        branch_slug: string;
      }>(
        `select d.id as doc_id,
                b.id as branch_id,
                d.title,
                b.name as branch_name,
                b.slug as branch_slug
           from documents d
           join document_branches b on b.doc_id = d.id
          where d.id = $1
            and b.id = $2
            and b.is_archived = false`,
        [docId, branchId],
      );
      const row = result.rows[0];
      if (!row) throw new Error('branch_not_found');

      res.json({
        docId: row.doc_id,
        branchId: row.branch_id,
        title: row.title,
        branchName: row.branch_name,
        branchSlug: row.branch_slug,
        access: {
          canRead: true,
          canWrite,
          canManageAccess: canWrite,
          canManageVersions: canWrite,
          canSwitchBranches: !isBranchScopedAccess(readAccess),
          actorType: readAccess?.actorType ?? 'user',
          ...(readAccess?.grantId ? { grantId: readAccess.grantId } : {}),
          ...(readAccess?.role ? { role: readAccess.role } : {}),
        },
      });
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

  router.post('/docs/:docId/branches/:branchId/versions/manual-save', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const docId = requiredParam(req, 'docId');
      const branchId = requiredParam(req, 'branchId');
      await options.auth?.requireDocumentAccess(req, docId, branchId, 'write');
      await options.flushCollabDocument?.(toRoomName(docId, branchId));
      const saved = await flushBranchMarkdownMirror(pool, docId, branchId, 'manual_save');
      res.json({
        created: saved.createdVersion,
        versionId: saved.versionId,
        versionNumber: saved.versionNumber,
        hash: saved.hash,
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/docs/:docId/branches/:branchId/versions/autosave', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const docId = requiredParam(req, 'docId');
      const branchId = requiredParam(req, 'branchId');
      await options.auth?.requireDocumentAccess(req, docId, branchId, 'write');
      await options.flushCollabDocument?.(toRoomName(docId, branchId));
      const saved = await flushBranchMarkdownMirror(pool, docId, branchId, 'autosave');
      res.json({
        created: saved.createdVersion,
        versionId: saved.versionId,
        versionNumber: saved.versionNumber,
        hash: saved.hash,
      });
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
      const sourceVersion = await showVersion(pool, docId, versionId);
      const access = await options.auth?.requireDocumentAccess(req, docId, sourceVersion.branchId, 'write');
      if (isBranchScopedAccess(access)) throw new Error('forbidden');
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
      await options.applyCollabDocumentState?.(toRoomName(docId, branchId), applied.yjsState);
      res.json({ versionId: applied.versionId, versionNumber: applied.versionNumber, hash: applied.hash });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
