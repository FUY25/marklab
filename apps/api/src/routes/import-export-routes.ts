import { Router, type NextFunction, type Request, type Response } from 'express';
import { buildExportFilename } from '@marklab/shared/src/export-filename';
import { sha256Hex } from '@marklab/shared/src/hash';
import { z } from 'zod';
import { toRoomName } from '../collab/persistence';
import type { DbPool } from '../db/client';
import type { CollabMarkdownSnapshot, HttpAppOptions } from '../http/app';
import { createDoc } from '../services/doc-create';
import { readBranchState } from '../services/doc-read';
import { flushBranchMarkdownMirror } from '../services/milkdown-transformer';
import { requireWorkspaceRole } from '../services/control-plane-access';
import { authenticateRequestUser } from '../services/user-service';
import { versionActorFromAccess } from '../services/version-actor';

const createSchema = z.object({
  title: z.string().min(1),
  workspaceId: z.string().min(1).optional(),
});

const importSchema = z.object({
  title: z.string().min(1),
  markdown: z.string(),
  workspaceId: z.string().min(1).optional(),
});

class ExportVersionMismatchError extends Error {
  constructor(
    public readonly currentHash: string,
    public readonly versionHash: string,
  ) {
    super('export_version_mismatch');
    this.name = 'ExportVersionMismatchError';
  }
}

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

async function docCreationContext(pool: DbPool, options: HttpAppOptions, req: Request, workspaceId: string | undefined) {
  if (workspaceId) {
    const user = await authenticateRequestUser(pool, req);
    if (!user) throw new Error('unauthorized');
    await requireWorkspaceRole(pool, { workspaceId, userId: user.userId, allowed: ['Owner', 'Member'] });
    return {
      actorType: 'user' as const,
      actorId: user.userId,
      ownerUserId: user.userId,
      workspaceId,
    };
  }

  const actor = versionActorFromAccess(await options.auth?.requireAdminAccess(req));
  const ownerUserId =
    actor.actorType === 'user'
    && actor.actorId
    && actor.actorId !== 'admin'
    && actor.actorId !== 'dev-anonymous'
      ? actor.actorId
      : undefined;
  return {
    ...actor,
    ...(ownerUserId ? { ownerUserId } : {}),
  };
}

export function createImportExportRoutes(pool: DbPool, options: HttpAppOptions = {}) {
  const router = Router();

  router.post('/docs', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = createSchema.parse(req.body);
      const context = await docCreationContext(pool, options, req, body.workspaceId);
      const result = await createDoc({ pool, title: body.title, markdown: '', operation: 'create', ...context });
      res.status(201).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/docs/import', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = importSchema.parse(req.body);
      const context = await docCreationContext(pool, options, req, body.workspaceId);
      const result = await createDoc({ pool, title: body.title, markdown: body.markdown, operation: 'import', ...context });
      res.status(201).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get('/docs/:docId/branches/:branchId/export.md', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const docId = requiredParam(req, 'docId');
      const branchId = requiredParam(req, 'branchId');

      await options.auth?.requireDocumentAccess(req, docId, branchId, 'read');
      const liveSnapshot = await options.collabSnapshotService?.readCurrentMarkdownSnapshot({ docId, branchId });
      let exported: CollabMarkdownSnapshot | null = liveSnapshot ?? null;
      if (!exported) {
        await options.flushCollabDocument?.(toRoomName(docId, branchId));
        const writeAccess = await optionalWriteAccess(options, req, docId, branchId);
        if (writeAccess) {
          const flushed = await flushBranchMarkdownMirror(pool, docId, branchId, 'manual_save', versionActorFromAccess(writeAccess));
          exported = {
            docId,
            branchId: flushed.branchId,
            versionId: flushed.versionId,
            versionNumber: flushed.versionNumber,
            hash: flushed.hash,
            markdown: flushed.markdown,
          };
        } else {
          exported = await readBranchState(pool, docId, branchId);
        }
      }

      const metadata = await pool.query<{ title: string; branch_slug: string; version_number: number | null }>(
        `select d.title, b.slug as branch_slug, v.version_number
           from documents d
           join document_branches b on b.doc_id = d.id
           left join document_versions v on v.id = b.head_version_id
          where d.id = $1 and b.id = $2 and b.is_archived = false`,
        [docId, branchId],
      );
      const metadataRow = metadata.rows[0];
      if (!metadataRow) throw new Error('branch_not_found');

      const bodyHash = sha256Hex(exported.markdown);
      if (bodyHash !== exported.hash) {
        throw new ExportVersionMismatchError(bodyHash, exported.hash);
      }

      const filename = buildExportFilename({
        title: metadataRow.title,
        docId,
        branchSlug: metadataRow.branch_slug,
        versionNumber: exported.versionNumber ?? metadataRow.version_number ?? 0,
        exportedAt: new Date(),
        hash: exported.hash,
      });

      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(exported.markdown);
    } catch (error) {
      if (error instanceof ExportVersionMismatchError) {
        res.status(409).json({
          error: 'export_version_mismatch',
          currentHash: error.currentHash,
          versionHash: error.versionHash,
        });
        return;
      }

      next(error);
    }
  });

  return router;
}
