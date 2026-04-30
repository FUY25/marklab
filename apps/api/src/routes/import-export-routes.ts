import { Router, type NextFunction, type Request, type Response } from 'express';
import { buildExportFilename } from '@marklab/shared/src/export-filename';
import { sha256Hex } from '@marklab/shared/src/hash';
import { z } from 'zod';
import { toRoomName } from '../collab/persistence';
import type { DbPool } from '../db/client';
import type { HttpAppOptions } from '../http/app';
import { createDoc } from '../services/doc-create';
import { flushBranchMarkdownMirror } from '../services/milkdown-transformer';

const createSchema = z.object({
  title: z.string().min(1),
});

const importSchema = z.object({
  title: z.string().min(1),
  markdown: z.string(),
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

export function createImportExportRoutes(pool: DbPool, options: HttpAppOptions = {}) {
  const router = Router();

  router.post('/docs', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = createSchema.parse(req.body);
      const result = await createDoc({ pool, title: body.title, markdown: '', operation: 'create' });
      res.status(201).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/docs/import', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = importSchema.parse(req.body);
      const result = await createDoc({ pool, title: body.title, markdown: body.markdown, operation: 'import' });
      res.status(201).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get('/docs/:docId/branches/:branchId/export.md', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const docId = requiredParam(req, 'docId');
      const branchId = requiredParam(req, 'branchId');

      await options.flushCollabDocument?.(toRoomName(docId, branchId));
      const flushed = await flushBranchMarkdownMirror(pool, docId, branchId, 'manual_save');

      const metadata = await pool.query<{ title: string; branch_slug: string }>(
        `select d.title, b.slug as branch_slug
           from documents d
           join document_branches b on b.doc_id = d.id
          where d.id = $1 and b.id = $2 and b.is_archived = false`,
        [docId, branchId],
      );
      const metadataRow = metadata.rows[0];
      if (!metadataRow) throw new Error('branch_not_found');

      const bodyHash = sha256Hex(flushed.markdown);
      if (bodyHash !== flushed.hash) {
        throw new ExportVersionMismatchError(bodyHash, flushed.hash);
      }

      const filename = buildExportFilename({
        title: metadataRow.title,
        docId,
        branchSlug: metadataRow.branch_slug,
        versionNumber: flushed.versionNumber,
        exportedAt: new Date(),
        hash: flushed.hash,
      });

      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(flushed.markdown);
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
