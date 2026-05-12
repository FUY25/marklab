import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { DbPool } from '../db/client';
import type { HttpAppOptions } from '../http/app';
import { readBranchState } from '../services/doc-read';
import { applyEditToMarkdown, EditConflictError } from '../services/doc-write';
import { applyMarkdownToBranchState } from '../services/editor-state';
import type { LiveMarkdownOperation, LiveMarkdownWriter } from '../services/live-writer';
import { flushBranchMarkdownMirror } from '../services/milkdown-transformer';
import { toRoomName } from '../collab/persistence';
import { versionActorFromAccess } from '../services/version-actor';

const writeSchema = z.object({
  baseVersionId: z.string().min(1),
  baseHash: z.string().min(1),
  markdown: z.string(),
});

const editSchema = z.object({
  observedVersionId: z.string().min(1).optional(),
  oldString: z.string().min(1),
  newString: z.string(),
  replaceAll: z.boolean().optional().default(false),
});

function requiredParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || !value) throw new Error(`missing_route_param:${name}`);
  return value;
}

async function optionalWriteAccess(options: HttpAppOptions, req: Request, docId: string, branchId: string) {
  if (!options.auth) return undefined;
  try {
    return await options.auth.requireDocumentAccess(req, docId, branchId, 'write');
  } catch (error) {
    if (error instanceof Error && error.message === 'forbidden') return undefined;
    throw error;
  }
}

export function createDocAiRoutes(pool: DbPool, liveWriter: LiveMarkdownWriter, options: HttpAppOptions = {}) {
  const router = Router();

  router.get('/docs/:docId/branches/:branchId/read', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const docId = requiredParam(req, 'docId');
      const branchId = requiredParam(req, 'branchId');
      await options.auth?.requireDocumentAccess(req, docId, branchId, 'read');
      await options.flushCollabDocument?.(toRoomName(docId, branchId));
      const writeAccess = await optionalWriteAccess(options, req, docId, branchId);
      if (writeAccess) {
        await flushBranchMarkdownMirror(pool, docId, branchId, 'autosave', versionActorFromAccess(writeAccess));
      }
      res.json(await readBranchState(pool, docId, branchId));
    } catch (error) {
      next(error);
    }
  });

  router.post('/docs/:docId/branches/:branchId/write', async (req: Request, res: Response, next: NextFunction) => {
    const docId = requiredParam(req, 'docId');
    const branchId = requiredParam(req, 'branchId');

    try {
      const access = await options.auth?.requireDocumentAccess(req, docId, branchId, 'write');
      const actor = versionActorFromAccess(access);
      const body = writeSchema.parse(req.body);
      await options.flushCollabDocument?.(toRoomName(docId, branchId));
      const current = await readBranchState(pool, docId, branchId);
      if (current.versionId !== body.baseVersionId) throw new Error('stale_base_version');

      const applied = await applyMarkdownToBranchState({
        pool,
        liveWriter,
        docId,
        branchId,
        parentVersionId: current.versionId,
        markdown: body.markdown,
        operation: { kind: 'write', baseVersionId: body.baseVersionId, baseHash: body.baseHash },
        actorType: actor.actorType,
        actorId: actor.actorId,
      });
      await options.applyCollabDocumentState?.(toRoomName(docId, branchId), applied.yjsState);

      res.json({ versionId: applied.versionId, versionNumber: applied.versionNumber, hash: applied.hash });
    } catch (error) {
      if (error instanceof Error && error.message === 'stale_base_version') {
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
      const access = await options.auth?.requireDocumentAccess(req, docId, branchId, 'write');
      const actor = versionActorFromAccess(access);
      const body = editSchema.parse(req.body);
      await options.flushCollabDocument?.(toRoomName(docId, branchId));
      const current = await readBranchState(pool, docId, branchId);
      let nextMarkdown: string;
      try {
        nextMarkdown = applyEditToMarkdown(current.markdown, body.oldString, body.newString, body.replaceAll);
      } catch (error) {
        if (error instanceof EditConflictError && error.message === 'old_string_not_found') {
          nextMarkdown = current.markdown;
        } else {
          throw error;
        }
      }
      const operation: LiveMarkdownOperation =
        body.observedVersionId === undefined
          ? {
              kind: 'edit',
              oldString: body.oldString,
              newString: body.newString,
              replaceAll: body.replaceAll,
            }
          : {
              kind: 'edit',
              observedVersionId: body.observedVersionId,
              oldString: body.oldString,
              newString: body.newString,
              replaceAll: body.replaceAll,
            };

      const applied = await applyMarkdownToBranchState({
        pool,
        liveWriter,
        docId,
        branchId,
        parentVersionId: current.versionId,
        markdown: nextMarkdown,
        operation,
        actorType: actor.actorType,
        actorId: actor.actorId,
      });
      await options.applyCollabDocumentState?.(toRoomName(docId, branchId), applied.yjsState);

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
