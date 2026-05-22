import { Router, type NextFunction, type Request, type Response } from 'express';
import { toRoomName } from '../collab/persistence';
import type { DbPool } from '../db/client';
import type { HttpAppOptions } from '../http/app';
import { deleteCloudCopy } from '../services/cloud-copy-service';
import { versionActorFromAccess } from '../services/version-actor';

function requiredParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || !value) throw new Error(`missing_route_param:${name}`);
  return value;
}

export function createCloudCopyRoutes(pool: DbPool, options: HttpAppOptions = {}) {
  const router = Router();

  router.delete('/docs/:docId/branches/:branchId/cloud-copy', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const docId = requiredParam(req, 'docId');
      const branchId = requiredParam(req, 'branchId');
      const access = await options.auth?.requireDocumentAccess(req, docId, branchId, 'write');
      if (!access?.canManageAccess) throw new Error('forbidden');
      const actor = versionActorFromAccess(access);
      const deleted = await deleteCloudCopy({
        pool,
        docId,
        branchId,
        actorType: actor.actorType,
        actorId: actor.actorId,
      });
      for (const deletedBranchId of deleted.branchIds) {
        options.closeCollabDocumentConnections?.(toRoomName(docId, deletedBranchId));
      }
      res.json({
        deleted: true,
        docId: deleted.docId,
        branchIds: deleted.branchIds,
        providerDocIds: deleted.providerDocIds,
        localFilePreserved: true,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
