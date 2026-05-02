import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express, { type ErrorRequestHandler, type NextFunction, type Request, type Response } from 'express';
import { ZodError } from 'zod';
import type { DbPool } from '../db/client';
import { createAccessRoutes } from '../routes/access-routes';
import { createDocAiRoutes } from '../routes/doc-ai-routes';
import { createImportExportRoutes } from '../routes/import-export-routes';
import { createLocalConflictRoutes } from '../routes/local-conflict-routes';
import { createLocalFileRoutes } from '../routes/local-file-routes';
import { createRelayRoutes } from '../routes/relay-routes';
import { createVersionRoutes } from '../routes/version-routes';
import {
  isAdminToken,
  verifyAdminToken,
  verifyDocumentAccess,
  type AccessOperation,
  type VerifiedDocumentAccess,
} from '../services/access-control';
import type { LiveMarkdownWriter } from '../services/live-writer';
import type { LocalFileService } from '../local/local-file-service';
import type { LocalRelayHostController, LocalRelayMirrorController } from '../local/local-relay-client';
import type { RelayRoomService } from '../relay/relay-room-service';
import type { RelayServerHandle } from '../relay/relay-server';

export interface HttpAppOptions {
  flushCollabDocument?: (roomName: string) => Promise<void>;
  applyCollabDocumentState?: (roomName: string, yjsState: Uint8Array) => Promise<void>;
  closeCollabDocumentConnections?: (roomName: string) => void;
  auth?: HttpRequestAuth;
  localFileService?: LocalFileService;
  localDaemonToken?: string;
  localMode?: boolean;
  relayService?: RelayRoomService;
  relayServer?: RelayServerHandle;
  allowedOrigins?: readonly string[];
  enforceAllowedOrigins?: boolean;
  health?: HttpHealthOptions;
  localRelayHost?: LocalRelayHostController;
  localRelayMirror?: LocalRelayMirrorController;
  enableLegacyDocAiRoutes?: boolean;
  staticWeb?: StaticWebOptions;
}

export interface HttpHealthOptions {
  databaseRequired?: boolean;
  relayRequired?: boolean;
  relayReady?: boolean;
  schemaTables?: readonly string[];
}

export interface StaticWebOptions {
  distDir: string;
}

export interface HttpRequestAuth {
  requireAdminAccess(req: Request): Promise<void>;
  requireDocumentAccess(
    req: Request,
    docId: string,
    branchId: string,
    operation: AccessOperation,
  ): Promise<VerifiedDocumentAccess | void>;
}

const defaultCorsOrigins = new Set([
  'http://127.0.0.1:5173',
  'http://localhost:5173',
  'http://127.0.0.1:5174',
  'http://localhost:5174',
  'http://127.0.0.1:5175',
  'http://localhost:5175',
  'http://127.0.0.1:5176',
  'http://localhost:5176',
  'http://127.0.0.1:5177',
  'http://localhost:5177',
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

function configuredCorsOrigins(customOrigins: readonly string[] = []): Set<string> {
  const origins = new Set(defaultCorsOrigins);
  for (const customOrigin of customOrigins) {
    const origin = normalizeOrigin(customOrigin);
    if (origin) origins.add(origin);
  }
  for (const envName of ['MARKLAB_WEB_ORIGIN', 'MARKLAB_CORS_ORIGIN', 'MARKLAB_ALLOWED_ORIGINS']) {
    const rawValue = process.env[envName];
    if (!rawValue) continue;

    for (const candidate of rawValue.split(',')) {
      const origin = normalizeOrigin(candidate);
      if (origin) origins.add(origin);
    }
  }
  return origins;
}

function createCorsMiddleware(input: { allowedOrigins?: readonly string[]; enforceAllowedOrigins?: boolean } = {}) {
  const allowedOrigins = configuredCorsOrigins(input.allowedOrigins);

  return (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', corsMethods);
      res.setHeader('Access-Control-Allow-Headers', corsHeaders);
      res.setHeader('Access-Control-Expose-Headers', exposedCorsHeaders);
    } else if (origin && input.enforceAllowedOrigins) {
      res.status(403).json({ error: 'origin_not_allowed' });
      return;
    }

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    next();
  };
}

async function readHealth(pool: DbPool, relayServer: RelayServerHandle | undefined, input: HttpHealthOptions = {}) {
  const database = { required: Boolean(input.databaseRequired), ready: false, error: null as string | null };
  const schema = { required: Boolean(input.databaseRequired), ready: false, missing: [] as string[], error: null as string | null };
  const relay = {
    required: Boolean(input.relayRequired),
    ready: !input.relayRequired || input.relayReady === true || Boolean(relayServer),
    connectionCount: relayServer?.connectionCount ?? 0,
  };

  if (!input.databaseRequired) {
    return {
      ok: relay.ready,
      process: { ready: true },
      database,
      schema,
      relay,
    };
  }

  try {
    await pool.query('select 1');
    database.ready = true;
  } catch (error) {
    database.error = error instanceof Error ? error.message : 'database_unavailable';
  }

  if (database.ready) {
    try {
      const tables = input.schemaTables ?? ['relay_rooms', 'relay_access_grants', 'relay_access_sessions'];
      const result = await pool.query<{ table_name: string }>(
        `select table_name
           from information_schema.tables
          where table_schema = 'public'
            and table_name = any($1::text[])`,
        [tables],
      );
      const present = new Set(result.rows.map((row) => row.table_name));
      schema.missing = tables.filter((table) => !present.has(table));
      schema.ready = schema.missing.length === 0;
    } catch (error) {
      schema.error = error instanceof Error ? error.message : 'schema_unavailable';
    }
  }

  return {
    ok: database.ready && schema.ready && relay.ready,
    process: { ready: true },
    database,
    schema,
    relay,
  };
}

function authRequired(): boolean {
  return process.env.MARKLAB_REQUIRE_AUTH === 'true';
}

function legacyHostedDocAiEnabled(): boolean {
  return process.env.MARKLAB_ENABLE_LEGACY_DOC_AI === 'true';
}

function bearerToken(req: Request): string | undefined {
  const match = /^Bearer\s+(.+)$/iu.exec(req.header('authorization') ?? '');
  return match?.[1];
}

function documentToken(req: Request): string | undefined {
  const queryToken = req.query.token;
  if (typeof queryToken === 'string' && queryToken) return queryToken;
  return bearerToken(req);
}

function createRequestAuth(pool: DbPool): HttpRequestAuth {
  return {
    async requireAdminAccess(req: Request) {
      if (!authRequired()) return;
      verifyAdminToken(bearerToken(req), process.env.MARKLAB_ADMIN_TOKEN_HASH);
    },
    async requireDocumentAccess(req: Request, docId: string, branchId: string, operation: AccessOperation) {
      if (!authRequired()) return { actorType: 'user' };
      const token = documentToken(req);
      if (isAdminToken(token, process.env.MARKLAB_ADMIN_TOKEN_HASH)) return { actorType: 'user' };
      return verifyDocumentAccess(pool, token, docId, branchId, operation);
    },
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

  if (error instanceof Error && error.message === 'document_not_found') {
    res.status(404).json({ error: 'document_not_found' });
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

  if (error instanceof Error && error.message === 'admin_token_not_configured') {
    res.status(503).json({ error: 'admin_token_not_configured' });
    return;
  }

  if (error instanceof Error && error.message === 'forbidden') {
    res.status(403).json({ error: 'forbidden' });
    return;
  }

  if (error instanceof Error && error.message === 'token_not_found') {
    res.status(404).json({ error: 'token_not_found' });
    return;
  }

  if (error instanceof Error && error.message === 'share_link_not_found') {
    res.status(404).json({ error: 'share_link_not_found' });
    return;
  }

  if (error instanceof Error && error.message === 'access_grant_not_found') {
    res.status(404).json({ error: 'access_grant_not_found' });
    return;
  }

  if (error instanceof Error && error.message === 'live_yjs_state_changed') {
    res.status(409).json({ error: 'live_yjs_state_changed' });
    return;
  }

  if (error instanceof Error && error.message === 'local_version_not_found') {
    res.status(404).json({ error: 'local_version_not_found' });
    return;
  }

  if (error instanceof Error && error.message === 'relay_service_not_configured') {
    res.status(503).json({ error: 'relay_service_not_configured' });
    return;
  }

  if (error instanceof Error && error.message === 'relay_management_token_not_configured') {
    res.status(503).json({ error: 'relay_management_token_not_configured' });
    return;
  }

  if (error instanceof Error && error.message === 'relay_room_not_found') {
    res.status(404).json({ error: 'relay_room_not_found' });
    return;
  }

  if (error instanceof Error && error.message === 'relay_access_grant_not_found') {
    res.status(404).json({ error: 'relay_access_grant_not_found' });
    return;
  }

  if (error instanceof Error && error.message === 'relay_shared_state_not_accepted') {
    res.status(409).json({ error: 'relay_shared_state_not_accepted' });
    return;
  }

  if (error instanceof Error && error.message === 'relay_sync_paused') {
    res.status(409).json({ error: 'relay_sync_paused' });
    return;
  }

  if (error instanceof Error && error.message === 'conflict_required') {
    res.status(409).json({ error: 'conflict_required' });
    return;
  }

  if (error instanceof Error && error.message === 'conflict_not_found') {
    res.status(404).json({ error: 'conflict_not_found' });
    return;
  }

  if (error instanceof Error && error.message === 'conflict_already_resolved') {
    res.status(409).json({ error: 'conflict_already_resolved' });
    return;
  }

  if (error instanceof Error && error.message === 'stale_conflict_shared_state') {
    res.status(409).json({ error: 'stale_conflict_shared_state' });
    return;
  }

  if (error instanceof Error && error.message === 'markdown_too_large') {
    res.status(413).json({ error: 'markdown_too_large' });
    return;
  }

  if (error instanceof Error && error.message === 'local_state_changed') {
    res.status(409).json({ error: 'local_state_changed' });
    return;
  }

  if (error instanceof Error && error.message.startsWith('missing_route_param:')) {
    res.status(400).json({ error: 'invalid_route' });
    return;
  }

  res.status(500).json({ error: 'internal_error' });
};

function mountStaticWeb(app: express.Express, staticWeb: StaticWebOptions | undefined): void {
  if (!staticWeb?.distDir || !existsSync(staticWeb.distDir)) return;

  const indexHtml = join(staticWeb.distDir, 'index.html');
  if (!existsSync(indexHtml)) return;

  app.use(express.static(staticWeb.distDir, { index: false }));
  app.get(/^\/(?!api\/|healthz$).*/u, (_req, res) => {
    res.sendFile(indexHtml);
  });
}

export function createHttpApp(pool: DbPool, liveWriter: LiveMarkdownWriter, options: HttpAppOptions = {}) {
  const app = express();
  const routeOptions = { ...options, auth: options.auth ?? createRequestAuth(pool) };
  const relayRouteOptions: Parameters<typeof createRelayRoutes>[0] = {};
  if (options.relayService) relayRouteOptions.relayService = options.relayService;
  if (options.relayServer) relayRouteOptions.relayServer = options.relayServer;
  const localMode = options.localMode ?? Boolean(options.localFileService);
  app.use(createCorsMiddleware({
    ...(options.allowedOrigins ? { allowedOrigins: options.allowedOrigins } : {}),
    enforceAllowedOrigins: options.enforceAllowedOrigins ?? false,
  }));
  app.use(express.json({ limit: '2mb' }));

  app.get('/healthz', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const health = await readHealth(pool, options.relayServer, options.health);
      res.status(health.ok ? 200 : 503).json(health);
    } catch (error) {
      next(error);
    }
  });

  if (localMode) {
    app.use('/api', createLocalFileRoutes(options.localFileService, routeOptions));
    app.use('/api', createLocalConflictRoutes(options.localFileService, routeOptions));
    app.use('/api', createRelayRoutes(relayRouteOptions));
  } else {
    app.use('/api', createAccessRoutes(pool, routeOptions));
    if (options.enableLegacyDocAiRoutes ?? legacyHostedDocAiEnabled()) app.use('/api', createDocAiRoutes(pool, liveWriter, routeOptions));
    app.use('/api', createImportExportRoutes(pool, routeOptions));
    app.use('/api', createLocalFileRoutes(options.localFileService, routeOptions));
    app.use('/api', createLocalConflictRoutes(options.localFileService, routeOptions));
    app.use('/api', createRelayRoutes(relayRouteOptions));
    app.use('/api', createVersionRoutes(pool, liveWriter, routeOptions));
  }

  mountStaticWeb(app, options.staticWeb);
  app.use(errorHandler);

  return app;
}
