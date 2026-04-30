import { Router, type NextFunction, type Request, type Response } from 'express';
import { buildExportFilename } from '@marklab/shared/src/export-filename';
import { z } from 'zod';
import type { DbPool } from '../db/client';
import { createDoc } from '../services/doc-create';
import { readBranchState } from '../services/doc-read';
import { flushBranchMarkdownMirror } from '../services/milkdown-transformer';

const createSchema = z.object({
  title: z.string().min(1),
});

const importSchema = z.object({
  title: z.string().min(1),
  markdown: z.string(),
});

function requiredParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || !value) throw new Error(`missing_route_param:${name}`);
  return value;
}

export function createImportExportRoutes(pool: DbPool) {
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

      await flushBranchMarkdownMirror(pool, docId, branchId);
      const state = await readBranchState(pool, docId, branchId);

      const metadata = await pool.query<{ title: string; branch_slug: string }>(
        `select d.title, b.slug as branch_slug
           from documents d
           join document_branches b on b.doc_id = d.id
          where d.id = $1 and b.id = $2 and b.is_archived = false`,
        [docId, branchId],
      );
      const metadataRow = metadata.rows[0];
      if (!metadataRow) throw new Error('branch_not_found');

      const filename = buildExportFilename({
        title: metadataRow.title,
        docId: state.docId,
        branchSlug: metadataRow.branch_slug,
        versionNumber: state.versionNumber,
        exportedAt: new Date(),
        hash: state.hash,
      });

      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(state.markdown);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
