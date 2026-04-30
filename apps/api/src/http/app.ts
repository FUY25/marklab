import express, { type ErrorRequestHandler, type NextFunction, type Request, type Response } from 'express';
import { ZodError } from 'zod';
import type { DbPool } from '../db/client';
import { createDocAiRoutes } from '../routes/doc-ai-routes';
import { createImportExportRoutes } from '../routes/import-export-routes';
import { createVersionRoutes } from '../routes/version-routes';
import type { LiveMarkdownWriter } from '../services/live-writer';

export interface HttpAppOptions {
  flushCollabDocument?: (roomName: string) => Promise<void>;
}

const defaultCorsOrigins = new Set([
  'http://127.0.0.1:5173',
  'http://localhost:5173',
  'http://127.0.0.1:5175',
  'http://localhost:5175',
]);
const corsMethods = 'GET, POST, DELETE, OPTIONS';
const corsHeaders = 'content-type, authorization';
const exposedCorsHeaders = 'content-disposition';

function normalizeOrigin(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === '*') return null;

  try {
    return new URL(trimmed).origin;
  } catch {
    return null;
  }
}

function configuredCorsOrigins(): Set<string> {
  const origins = new Set(defaultCorsOrigins);
  for (const envName of ['MARKLAB_WEB_ORIGIN', 'MARKLAB_CORS_ORIGIN']) {
    const rawValue = process.env[envName];
    if (!rawValue) continue;

    for (const candidate of rawValue.split(',')) {
      const origin = normalizeOrigin(candidate);
      if (origin) origins.add(origin);
    }
  }
  return origins;
}

function createCorsMiddleware() {
  const allowedOrigins = configuredCorsOrigins();

  return (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', corsMethods);
      res.setHeader('Access-Control-Allow-Headers', corsHeaders);
      res.setHeader('Access-Control-Expose-Headers', exposedCorsHeaders);
    }

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    next();
  };
}

const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof ZodError) {
    res.status(400).json({ error: 'invalid_request', issues: error.issues });
    return;
  }

  if (error instanceof Error && error.message === 'branch_not_found') {
    res.status(404).json({ error: 'branch_not_found' });
    return;
  }

  if (error instanceof Error && (error.message === 'version_not_found' || error.message === 'source_version_not_found')) {
    res.status(404).json({ error: error.message });
    return;
  }

  if (error instanceof Error && error.message === 'live_writer_not_configured') {
    res.status(503).json({ error: 'live_writer_not_configured' });
    return;
  }

  if (error instanceof Error && error.message === 'invalid_live_yjs_state') {
    res.status(503).json({ error: 'invalid_live_yjs_state' });
    return;
  }

  if (error instanceof Error && error.message === 'live_writer_missing_previous_hash') {
    res.status(503).json({ error: 'live_writer_missing_previous_hash' });
    return;
  }

  if (error instanceof Error && error.message === 'stale_live_base_hash') {
    res.status(409).json({ error: 'live_yjs_state_changed' });
    return;
  }

  if (error instanceof Error && error.message === 'milkdown_transformer_not_configured') {
    res.status(503).json({ error: 'milkdown_transformer_not_configured' });
    return;
  }

  if (error instanceof Error && error.message === 'live_yjs_state_changed') {
    res.status(409).json({ error: 'live_yjs_state_changed' });
    return;
  }

  if (error instanceof Error && error.message.startsWith('missing_route_param:')) {
    res.status(400).json({ error: 'invalid_route' });
    return;
  }

  res.status(500).json({ error: 'internal_error' });
};

export function createHttpApp(pool: DbPool, liveWriter: LiveMarkdownWriter, options: HttpAppOptions = {}) {
  const app = express();
  app.use(createCorsMiddleware());
  app.use(express.json({ limit: '2mb' }));

  app.get('/healthz', (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  app.use('/api', createDocAiRoutes(pool, liveWriter, options));
  app.use('/api', createImportExportRoutes(pool, options));
  app.use('/api', createVersionRoutes(pool));
  app.use(errorHandler);

  return app;
}
