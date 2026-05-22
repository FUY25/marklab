import { Router, type NextFunction, type Request, type Response } from 'express';
import { toRoomName } from '../collab/persistence';
import type { DbPool } from '../db/client';
import type { HttpAppOptions } from '../http/app';
import { deleteCloudCopy } from '../services/cloud-copy-service';
import { isAdminToken } from '../services/access-control';
import { authenticateRequestUser, bearerToken } from '../services/user-service';
import { versionActorFromAccess } from '../services/version-actor';

function requiredParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || !value) throw new Error(`missing_route_param:${name}`);
  return value;
}

interface DeletedCloudCopyRow {
  doc_id: string;
  branch_id: string;
  provider_doc_id: string;
  deleted_by_actor_type: 'user' | 'agent' | 'system';
  deleted_by_actor_id: string | null;
}

async function readAuthorizedDeletedCloudCopy(
  pool: DbPool,
  req: Request,
  options: HttpAppOptions,
  docId: string,
  branchId: string,
) {
  const deleted = await pool.query<DeletedCloudCopyRow>(
    `select doc_id,
            branch_id,
            provider_doc_id,
            deleted_by_actor_type,
            deleted_by_actor_id
       from provider_doc_deletions
      where doc_id = $1
      order by created_at asc`,
    [docId],
  );
  if (!deleted.rows.some((row) => row.branch_id === branchId)) return null;

  const adminTokenHash = options.authEnvironment?.adminTokenHash ?? process.env.MARKLAB_ADMIN_TOKEN_HASH;
  const isAdmin = isAdminToken(bearerToken(req), adminTokenHash);
  if (!isAdmin) {
    const user = await authenticateRequestUser(pool, req);
    if (!user) return null;
    const ownedByUser = deleted.rows.every((row) => (
      row.deleted_by_actor_type === 'user'
      && row.deleted_by_actor_id === user.userId
    ));
    if (!ownedByUser) return null;
  }

  return {
    docId,
    branchIds: deleted.rows.map((row) => row.branch_id),
    providerDocIds: deleted.rows.map((row) => row.provider_doc_id),
  };
}

export function createCloudCopyRoutes(pool: DbPool, options: HttpAppOptions = {}) {
  const router = Router();

  router.delete('/docs/:docId/branches/:branchId/cloud-copy', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const docId = requiredParam(req, 'docId');
      const branchId = requiredParam(req, 'branchId');
      let access: Awaited<ReturnType<NonNullable<HttpAppOptions['auth']>['requireDocumentAccess']>>;
      try {
        access = await options.auth?.requireDocumentAccess(req, docId, branchId, 'write');
        if (!access?.canManageAccess) throw new Error('forbidden');
      } catch (error) {
        const alreadyDeleted = await readAuthorizedDeletedCloudCopy(pool, req, options, docId, branchId);
        if (alreadyDeleted) {
          res.json({
            deleted: true,
            docId: alreadyDeleted.docId,
            branchIds: alreadyDeleted.branchIds,
            providerDocIds: alreadyDeleted.providerDocIds,
            localFilePreserved: true,
          });
          return;
        }
        throw error;
      }
      const actor = versionActorFromAccess(access);
      let deleted: Awaited<ReturnType<typeof deleteCloudCopy>>;
      try {
        deleted = await deleteCloudCopy({
          pool,
          docId,
          branchId,
          actorType: actor.actorType,
          actorId: actor.actorId,
        });
      } catch (error) {
        const alreadyDeleted = await readAuthorizedDeletedCloudCopy(pool, req, options, docId, branchId);
        if (alreadyDeleted) {
          res.json({
            deleted: true,
            docId: alreadyDeleted.docId,
            branchIds: alreadyDeleted.branchIds,
            providerDocIds: alreadyDeleted.providerDocIds,
            localFilePreserved: true,
          });
          return;
        }
        throw error;
      }
      for (const deletedBranchId of deleted.branchIds) {
        options.closeCollabDocumentConnections?.(toRoomName(docId, deletedBranchId));
      }
      options.closeProviderDocConnections?.(deleted.providerDocIds);
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
