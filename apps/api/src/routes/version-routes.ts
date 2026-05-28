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
import {
  getDocumentSummary,
  listBranches,
  listVersions,
  persistBranchMarkdownSnapshot,
  showVersion,
  type VersionOperation,
} from '../services/version-service';
import { versionActorFromAccess } from '../services/version-actor';

const restoreSchema = z.object({
  versionId: z.string().min(1),
});

function requiredParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || !value) throw new Error(`missing_route_param:${name}`);
  return value;
}

function authRequired(options: HttpAppOptions): boolean {
  return options.authEnvironment?.requireAuth ?? process.env.MARKLAB_REQUIRE_AUTH === 'true';
}

function isBranchScopedAccess(access: VerifiedDocumentAccess | void): boolean {
  return Boolean(access?.grantId);
}

function isPublicViewGrant(access: VerifiedDocumentAccess | void): boolean {
  return access?.grantSource === 'document_access_grants' && access.role === 'view';
}

async function saveBranchVersion(
  pool: DbPool,
  options: HttpAppOptions,
  input: {
    docId: string;
    branchId: string;
    operation: Extract<VersionOperation, 'autosave' | 'manual_save'>;
    actor: ReturnType<typeof versionActorFromAccess>;
  },
) {
  const liveSnapshot = await options.collabSnapshotService?.readCurrentMarkdownSnapshot({
    docId: input.docId,
    branchId: input.branchId,
  });
  if (liveSnapshot) {
    return persistBranchMarkdownSnapshot({
      pool,
      docId: input.docId,
      branchId: input.branchId,
      markdown: liveSnapshot.markdown,
      hash: liveSnapshot.hash,
      yjsState: liveSnapshot.yjsState,
      operation: input.operation,
      actorType: input.actor.actorType,
      actorId: input.actor.actorId,
    });
  }

  await options.flushCollabDocument?.(toRoomName(input.docId, input.branchId));
  return flushBranchMarkdownMirror(pool, input.docId, input.branchId, input.operation, input.actor);
}

export function createVersionRoutes(pool: DbPool, liveWriter: LiveMarkdownWriter, options: HttpAppOptions = {}) {
  const router = Router();

  router.get('/docs/:docId', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const docId = requiredParam(req, 'docId');
      const doc = await getDocumentSummary(pool, docId);
      let access: VerifiedDocumentAccess | void = undefined;
      if (doc.defaultBranchId) access = await options.auth?.requireDocumentAccess(req, docId, doc.defaultBranchId, 'read');
      else if (authRequired(options)) throw new Error('forbidden');
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
      else if (authRequired(options)) throw new Error('forbidden');
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
          canManageAccess: Boolean(readAccess?.canManageAccess ?? (!authRequired(options) && canWrite)),
          canManageVersions: canWrite,
          canSwitchBranches: false,
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
      const access = await options.auth?.requireDocumentAccess(req, docId, branchId, 'read');
      if (isPublicViewGrant(access)) throw new Error('forbidden');
      res.json({ versions: await listVersions(pool, docId, branchId) });
    } catch (error) {
      next(error);
    }
  });

  router.post('/docs/:docId/branches/:branchId/versions/manual-save', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const docId = requiredParam(req, 'docId');
      const branchId = requiredParam(req, 'branchId');
      const access = await options.auth?.requireDocumentAccess(req, docId, branchId, 'write');
      const saved = await saveBranchVersion(pool, options, {
        docId,
        branchId,
        operation: 'manual_save',
        actor: versionActorFromAccess(access),
      });
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
      const access = await options.auth?.requireDocumentAccess(req, docId, branchId, 'write');
      const saved = await saveBranchVersion(pool, options, {
        docId,
        branchId,
        operation: 'autosave',
        actor: versionActorFromAccess(access),
      });
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
      const access = await options.auth?.requireDocumentAccess(req, docId, version.branchId, 'read');
      if (isPublicViewGrant(access)) throw new Error('forbidden');
      res.json(version);
    } catch (error) {
      next(error);
    }
  });

  router.post('/docs/:docId/versions/:versionId/branch', (_req: Request, res: Response) => {
    res.status(404).json({ error: 'not_found' });
  });

  router.post('/docs/:docId/branches/:branchId/restore', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const docId = requiredParam(req, 'docId');
      const branchId = requiredParam(req, 'branchId');
      const access = await options.auth?.requireDocumentAccess(req, docId, branchId, 'write');
      const actor = versionActorFromAccess(access);
      const body = restoreSchema.parse(req.body);
      const liveSnapshot = await options.collabSnapshotService?.readCurrentMarkdownSnapshot({ docId, branchId });
      let applied: Awaited<ReturnType<typeof restoreVersionToBranchState>>;
      if (liveSnapshot) {
        if (!options.collabSnapshotService?.applyMarkdownSnapshot) throw new Error('collab_snapshot_unavailable');
        const source = await showVersion(pool, docId, body.versionId);
        if (source.branchId !== branchId) throw new Error('source_version_not_found');
        await persistBranchMarkdownSnapshot({
          pool,
          docId,
          branchId,
          markdown: liveSnapshot.markdown,
          hash: liveSnapshot.hash,
          yjsState: liveSnapshot.yjsState,
          operation: 'manual_save',
          actorType: actor.actorType,
          actorId: actor.actorId,
        });
        let providerRollbackApplied = false;
        try {
          await options.collabSnapshotService.applyMarkdownSnapshot({
            docId,
            branchId,
            markdown: source.markdown,
            expectedCurrentHash: liveSnapshot.hash,
          });
          providerRollbackApplied = true;
          applied = await restoreVersionToBranchState({
            pool,
            liveWriter,
            docId,
            branchId,
            versionId: body.versionId,
            actorType: actor.actorType,
            actorId: actor.actorId,
          });
        } catch (error) {
          if (providerRollbackApplied) {
            try {
              await options.collabSnapshotService.applyMarkdownSnapshot({
                docId,
                branchId,
                markdown: liveSnapshot.markdown,
              });
            } catch {
              // Preserve the original restore failure; provider compensation is best effort.
            }
          }
          throw error;
        }
      } else {
        await options.flushCollabDocument?.(toRoomName(docId, branchId));
        await readBranchState(pool, docId, branchId);
        applied = await restoreVersionToBranchState({
          pool,
          liveWriter,
          docId,
          branchId,
          versionId: body.versionId,
          actorType: actor.actorType,
          actorId: actor.actorId,
        });
        await options.collabSnapshotService?.applyMarkdownSnapshot?.({
          docId,
          branchId,
          markdown: applied.canonicalMarkdown,
        });
      }
      await options.applyCollabDocumentState?.(
        toRoomName(docId, branchId),
        applied.yjsState,
        liveSnapshot ? { expectedCurrentHash: liveSnapshot.hash } : undefined,
      );
      res.json({ versionId: applied.versionId, versionNumber: applied.versionNumber, hash: applied.hash });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
