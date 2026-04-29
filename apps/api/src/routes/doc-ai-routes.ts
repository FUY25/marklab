import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { DbPool } from '../db/client';
import { readBranchState } from '../services/doc-read';
import { applyEditToMarkdown, assertCanWrite, EditConflictError } from '../services/doc-write';
import { applyMarkdownToBranchState, type LiveMarkdownWriter } from '../services/editor-state';

const writeSchema = z.object({
  baseVersionId: z.string().min(1),
  baseHash: z.string().min(1),
  markdown: z.string(),
});

const editSchema = z.object({
  baseVersionId: z.string().min(1),
  oldString: z.string().min(1),
  newString: z.string(),
  replaceAll: z.boolean().optional().default(false),
});

function requiredParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || !value) throw new Error(`missing_route_param:${name}`);
  return value;
}

export function createDocAiRoutes(pool: DbPool, liveWriter: LiveMarkdownWriter) {
  const router = Router();

  router.get('/docs/:docId/branches/:branchId/read', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const docId = requiredParam(req, 'docId');
      const branchId = requiredParam(req, 'branchId');
      res.json(await readBranchState(pool, docId, branchId));
    } catch (error) {
      next(error);
    }
  });

  router.post('/docs/:docId/branches/:branchId/write', async (req: Request, res: Response, next: NextFunction) => {
    const docId = requiredParam(req, 'docId');
    const branchId = requiredParam(req, 'branchId');

    try {
      const body = writeSchema.parse(req.body);
      const current = await readBranchState(pool, docId, branchId);
      assertCanWrite(current.versionId, current.hash, body.baseVersionId, body.baseHash);

      const applied = await applyMarkdownToBranchState({
        pool,
        liveWriter,
        docId,
        branchId,
        parentVersionId: current.versionId,
        markdown: body.markdown,
        operation: 'write',
        actorType: 'agent',
      });

      res.json({ versionId: applied.versionId, versionNumber: applied.versionNumber, hash: applied.hash });
    } catch (error) {
      if (error instanceof Error && (error.message === 'stale_base_hash' || error.message === 'stale_base_version')) {
        try {
          const current = await readBranchState(pool, docId, branchId);
          res.status(409).json({
            error: error.message,
            currentVersionId: current.versionId,
            currentHash: current.hash,
          });
        } catch (readError) {
          next(readError);
        }
        return;
      }

      next(error);
    }
  });

  router.post('/docs/:docId/branches/:branchId/edit', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const docId = requiredParam(req, 'docId');
      const branchId = requiredParam(req, 'branchId');
      const body = editSchema.parse(req.body);
      const current = await readBranchState(pool, docId, branchId);
      const nextMarkdown = applyEditToMarkdown(current.markdown, body.oldString, body.newString, body.replaceAll);

      const applied = await applyMarkdownToBranchState({
        pool,
        liveWriter,
        docId,
        branchId,
        parentVersionId: current.versionId,
        markdown: nextMarkdown,
        operation: 'edit',
        actorType: 'agent',
      });

      res.json({ versionId: applied.versionId, versionNumber: applied.versionNumber, hash: applied.hash });
    } catch (error) {
      if (error instanceof EditConflictError) {
        if (error.message === 'ambiguous_match') {
          res.status(409).json({ error: 'ambiguous_match', matchCount: error.matchCount });
          return;
        }

        res.status(409).json({ error: error.message });
        return;
      }

      next(error);
    }
  });

  return router;
}
