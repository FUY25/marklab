import express, { type ErrorRequestHandler, type Request, type Response } from 'express';
import { ZodError } from 'zod';
import type { DbPool } from '../db/client';
import { createDocAiRoutes } from '../routes/doc-ai-routes';
import { createImportExportRoutes } from '../routes/import-export-routes';
import type { LiveMarkdownWriter } from '../services/live-writer';

const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof ZodError) {
    res.status(400).json({ error: 'invalid_request', issues: error.issues });
    return;
  }

  if (error instanceof Error && error.message === 'branch_not_found') {
    res.status(404).json({ error: 'branch_not_found' });
    return;
  }

  if (error instanceof Error && error.message === 'live_writer_not_configured') {
    res.status(503).json({ error: 'live_writer_not_configured' });
    return;
  }

  if (error instanceof Error && error.message === 'milkdown_transformer_not_configured') {
    res.status(503).json({ error: 'milkdown_transformer_not_configured' });
    return;
  }

  if (error instanceof Error && error.message.startsWith('missing_route_param:')) {
    res.status(400).json({ error: 'invalid_route' });
    return;
  }

  res.status(500).json({ error: 'internal_error' });
};

export function createHttpApp(pool: DbPool, liveWriter: LiveMarkdownWriter) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.get('/healthz', (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  app.use('/api', createDocAiRoutes(pool, liveWriter));
  app.use('/api', createImportExportRoutes(pool));
  app.use(errorHandler);

  return app;
}
