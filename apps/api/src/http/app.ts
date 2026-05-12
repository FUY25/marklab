import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express, { type ErrorRequestHandler, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { ZodError } from 'zod';
import type { DbPool } from '../db/client';
import { createAccessRoutes } from '../routes/access-routes';
import { createAuthRoutes } from '../routes/auth-routes';
import { createCollabSessionRoutes } from '../routes/collab-session-routes';
import { createDocAiRoutes } from '../routes/doc-ai-routes';
import { createImportExportRoutes } from '../routes/import-export-routes';
import { createLocalConflictRoutes } from '../routes/local-conflict-routes';
import { createLocalFileRoutes } from '../routes/local-file-routes';
import { createRelayRoutes } from '../routes/relay-routes';
import { createVersionRoutes } from '../routes/version-routes';
import { createWorkspaceRoutes } from '../routes/workspace-routes';
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
import type { RelayRoomService, RelayRouteService } from '../relay/relay-room-service';
import type { RelayServerHandle } from '../relay/relay-server';
import type { ProviderTokenService } from '../provider/ysweet-token-service';
import { authenticateRequestUser } from '../services/user-service';
import { requireUserDocumentAccess } from '../services/control-plane-access';
import type { OidcAuthConfig, OidcExchange } from '../services/oidc-service';

export interface HttpAppOptions {
  flushCollabDocument?: (roomName: string) => Promise<void>;
  applyCollabDocumentState?: (roomName: string, yjsState: Uint8Array) => Promise<void>;
  closeCollabDocumentConnections?: (roomName: string) => void;
  collabSnapshotService?: CollabSnapshotService;
  auth?: HttpRequestAuth;
  localFileService?: LocalFileService;
  localDaemonToken?: string;
  localMode?: boolean;
  relayService?: RelayRoomService;
  relayRouteService?: RelayRouteService;
  relayServer?: RelayServerHandle;
  providerTokenService?: ProviderTokenService;
  providerHttpProxy?: RequestHandler;
  allowedOrigins?: readonly string[];
  enforceAllowedOrigins?: boolean;
  health?: HttpHealthOptions;
  localRelayHost?: LocalRelayHostController;
  localRelayMirror?: LocalRelayMirrorController;
  enableLegacyDocAiRoutes?: boolean;
  staticWeb?: StaticWebOptions;
  authEnvironment?: Partial<HttpAuthEnvironment>;
  oidcExchange?: OidcExchange;
}

export interface HttpAuthEnvironment {
  requireAuth: boolean;
  devAnonymousAccess: boolean;
  devAuth: boolean;
  adminTokenHash: string | undefined;
  nodeEnv: string | undefined;
  legacyHostedDocAi: boolean;
  oidc: OidcAuthConfig | undefined;
}

export interface HttpHealthOptions {
  databaseRequired?: boolean;
  relayRequired?: boolean;
  relayReady?: boolean;
  providerRequired?: boolean;
  providerHealth?: () => Promise<HttpProviderHealthSnapshot>;
  schemaTables?: readonly string[];
  schemaColumns?: Readonly<Record<string, readonly string[]>>;
}

export interface HttpProviderHealthSnapshot {
  mode: string;
  ready: boolean;
  storeReady?: boolean;
  serverUrl: string;
  error?: string | null;
}

export interface StaticWebOptions {
  distDir: string;
}

export interface CollabMarkdownSnapshot {
  docId: string;
  branchId: string;
  versionId: string | null;
  versionNumber: number | null;
  hash: string;
  markdown: string;
}

export interface CollabSnapshotService {
  readCurrentMarkdownSnapshot(input: { docId: string; branchId: string }): Promise<CollabMarkdownSnapshot | null>;
}

export interface HttpRequestAuth {
  requireAdminAccess(req: Request): Promise<VerifiedDocumentAccess | void>;
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
const corsMethods = 'GET, POST, PATCH, DELETE, OPTIONS';
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
      res.setHeader('Access-Control-Allow-Credentials', 'true');
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
  const provider = {
    required: Boolean(input.providerRequired),
    ready: !input.providerRequired,
    storeReady: null as boolean | null,
    mode: null as string | null,
    serverUrl: null as string | null,
    error: null as string | null,
  };

  if (input.providerHealth) {
    try {
      const providerSnapshot = await input.providerHealth();
      provider.mode = providerSnapshot.mode;
      provider.serverUrl = providerSnapshot.serverUrl;
      provider.storeReady = providerSnapshot.storeReady ?? null;
      provider.error = providerSnapshot.error ?? null;
      provider.ready = providerSnapshot.ready && (provider.required ? providerSnapshot.storeReady === true : providerSnapshot.storeReady !== false);
    } catch (error) {
      provider.ready = false;
      provider.error = error instanceof Error ? error.message : 'provider_health_failed';
    }
  } else if (provider.required) {
    provider.ready = false;
    provider.error = 'provider_health_not_configured';
  }
  const providerReadyForGate = !provider.required || provider.ready;

  if (!input.databaseRequired) {
    return {
      ok: relay.ready && providerReadyForGate,
      process: { ready: true },
      database,
      schema,
      relay,
      provider,
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
      const schemaColumns = input.schemaColumns ?? {};
      const tables = Array.from(new Set([
        ...(input.schemaTables ?? [
          'users',
          'user_sessions',
          'oidc_login_states',
          'workspaces',
          'workspace_members',
          'workspace_share_keys',
          'workspace_folders',
          'folder_access_policies',
          'plans',
          'seat_limits',
          'subscriptions',
          'document_access_grants',
          'document_access_sessions',
          'share_links',
          'relay_rooms',
          'relay_access_grants',
          'relay_access_sessions',
          'document_branch_states',
          'collab_sessions',
          'provider_token_issuances',
          'provider_token_refreshes',
        ]),
        ...Object.keys(schemaColumns),
      ]));
      const result = await pool.query<{ table_name: string }>(
        `select table_name
           from information_schema.tables
          where table_schema = 'public'
            and table_name = any($1::text[])`,
        [tables],
      );
      const present = new Set(result.rows.map((row) => row.table_name));
      schema.missing = tables.filter((table) => !present.has(table));

      const columnTables = Object.keys(schemaColumns).filter((table) => present.has(table));
      const columnNames = Array.from(new Set(Object.values(schemaColumns).flat()));
      if (columnTables.length > 0 && columnNames.length > 0) {
        const columnResult = await pool.query<{ table_name: string; column_name: string }>(
          `select table_name, column_name
             from information_schema.columns
            where table_schema = 'public'
              and table_name = any($1::text[])
              and column_name = any($2::text[])`,
          [columnTables, columnNames],
        );
        const presentColumns = new Set(columnResult.rows.map((row) => `${row.table_name}.${row.column_name}`));
        for (const table of columnTables) {
          for (const column of schemaColumns[table] ?? []) {
            const key = `${table}.${column}`;
            if (!presentColumns.has(key)) schema.missing.push(key);
          }
        }
      }
      schema.ready = schema.missing.length === 0;
    } catch (error) {
      schema.error = error instanceof Error ? error.message : 'schema_unavailable';
    }
  }

  return {
    ok: database.ready && schema.ready && relay.ready && providerReadyForGate,
    process: { ready: true },
    database,
    schema,
    relay,
    provider,
  };
}

function readAuthEnvironment(input: Partial<HttpAuthEnvironment> = {}): HttpAuthEnvironment {
  const oidc = input.oidc ?? readOidcEnvironment();
  const nodeEnv = input.nodeEnv ?? process.env.NODE_ENV;
  const requestedDevAuth = input.devAuth ?? process.env.MARKLAB_ENABLE_DEV_AUTH === 'true';
  return {
    requireAuth: input.requireAuth ?? process.env.MARKLAB_REQUIRE_AUTH === 'true',
    devAnonymousAccess: input.devAnonymousAccess ?? process.env.MARKLAB_ENABLE_DEV_ANONYMOUS_COLLAB === 'true',
    devAuth: nodeEnv === 'production' ? false : requestedDevAuth,
    adminTokenHash: input.adminTokenHash ?? process.env.MARKLAB_ADMIN_TOKEN_HASH,
    nodeEnv,
    legacyHostedDocAi: input.legacyHostedDocAi ?? process.env.MARKLAB_ENABLE_LEGACY_DOC_AI === 'true',
    oidc,
  };
}

function readOidcEnvironment(): OidcAuthConfig | undefined {
  const issuer = process.env.MARKLAB_OIDC_ISSUER;
  const clientId = process.env.MARKLAB_OIDC_CLIENT_ID;
  const clientSecret = process.env.MARKLAB_OIDC_CLIENT_SECRET;
  const redirectUri = process.env.MARKLAB_OIDC_REDIRECT_URI;
  const authorizationEndpoint = process.env.MARKLAB_OIDC_AUTHORIZATION_ENDPOINT;
  if (!issuer || !clientId || !clientSecret || !redirectUri) return undefined;
  return {
    issuer,
    clientId,
    clientSecret,
    redirectUri,
    ...(authorizationEndpoint ? { authorizationEndpoint } : {}),
  };
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

function createRequestAuth(pool: DbPool, authEnvironment: HttpAuthEnvironment): HttpRequestAuth {
  return {
    async requireAdminAccess(req: Request) {
      if (!authEnvironment.requireAuth && authEnvironment.devAnonymousAccess) return { actorType: 'user', actorId: 'dev-anonymous' };
      verifyAdminToken(bearerToken(req), authEnvironment.adminTokenHash);
      return { actorType: 'user', actorId: 'admin', canManageAccess: true };
    },
    async requireDocumentAccess(req: Request, docId: string, branchId: string, operation: AccessOperation) {
      if (!authEnvironment.requireAuth && authEnvironment.devAnonymousAccess) return { actorType: 'user', actorId: 'dev-anonymous' };
      const token = documentToken(req);
      if (isAdminToken(bearerToken(req), authEnvironment.adminTokenHash)) return { actorType: 'user', actorId: 'admin', canManageAccess: true };
      const user = await authenticateRequestUser(pool, req);
      if (user) {
        try {
          return await requireUserDocumentAccess(pool, { userId: user.userId, docId, branchId, operation });
        } catch (error) {
          if (!(error instanceof Error) || error.message !== 'forbidden') throw error;
          if (operation === 'write') {
            let hasReadAccess = false;
            try {
              await requireUserDocumentAccess(pool, { userId: user.userId, docId, branchId, operation: 'read' });
              hasReadAccess = true;
            } catch (readError) {
              if (!(readError instanceof Error) || readError.message !== 'forbidden') throw readError;
            }
            if (hasReadAccess) throw new Error('forbidden');
          }
        }
      }
      if (isAdminToken(token, authEnvironment.adminTokenHash)) return { actorType: 'user', actorId: 'admin', canManageAccess: true };
      return verifyDocumentAccess(pool, token, docId, branchId, operation);
    },
  };
}

const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof ZodError) {
    res.status(400).json({ error: 'invalid_request', issues: error.issues });
    return;
  }

  if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '22P02') {
    res.status(400).json({ error: 'invalid_request' });
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

  if (error instanceof Error && error.message === 'auth_not_configured') {
    res.status(503).json({ error: 'auth_not_configured' });
    return;
  }

  if (error instanceof Error && error.message === 'dev_auth_disabled') {
    res.status(403).json({ error: 'dev_auth_disabled' });
    return;
  }

  if (error instanceof Error && error.message === 'oidc_not_configured') {
    res.status(503).json({ error: 'oidc_not_configured' });
    return;
  }

  if (
    error instanceof Error
    && (
      error.message === 'oidc_discovery_failed'
      || error.message === 'oidc_code_exchange_failed'
      || error.message === 'oidc_userinfo_failed'
      || error.message === 'oidc_issuer_mismatch'
      || error.message === 'oidc_insecure_endpoint'
      || error.message === 'oidc_login_state_invalid'
      || error.message === 'oidc_unverified_email'
      || error.message === 'oidc_missing_token_endpoint'
      || error.message === 'oidc_missing_userinfo_endpoint'
      || error.message === 'oidc_missing_authorization_endpoint'
    )
  ) {
    res.status(401).json({ error: 'oidc_login_failed' });
    return;
  }

  if (error instanceof Error && error.message === 'oidc_invalid_claims') {
    res.status(400).json({ error: 'oidc_invalid_claims' });
    return;
  }

  if (error instanceof Error && error.message === 'unauthorized') {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  if (error instanceof Error && error.message === 'invalid_email') {
    res.status(400).json({ error: 'invalid_email' });
    return;
  }

  if (error instanceof Error && error.message === 'email_already_linked') {
    res.status(409).json({ error: 'email_already_linked' });
    return;
  }

  if (error instanceof Error && error.message === 'provider_token_service_not_configured') {
    res.status(503).json({ error: 'provider_token_service_not_configured' });
    return;
  }

  if (error instanceof Error && error.message === 'collab_snapshot_service_not_configured') {
    res.status(503).json({ error: 'collab_snapshot_service_not_configured' });
    return;
  }

  if (error instanceof Error && error.message === 'collab_snapshot_unavailable') {
    res.status(503).json({ error: 'collab_snapshot_unavailable' });
    return;
  }

  if (error instanceof Error && error.message === 'collab_session_not_found') {
    res.status(404).json({ error: 'collab_session_not_found' });
    return;
  }

  if (error instanceof Error && error.message === 'guest_session_quota_exceeded') {
    res.status(429).json({ error: 'guest_session_quota_exceeded' });
    return;
  }

  if (error instanceof Error && (error.message === 'grant_revoked' || error.message === 'grant_expired' || error.message === 'provider_token_revoked')) {
    res.status(403).json({ error: error.message });
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

  if (error instanceof Error && error.message === 'workspace_share_key_not_found') {
    res.status(404).json({ error: 'workspace_share_key_not_found' });
    return;
  }

  if (error instanceof Error && error.message === 'workspace_not_found') {
    res.status(404).json({ error: 'workspace_not_found' });
    return;
  }

  if (error instanceof Error && error.message === 'workspace_member_not_found') {
    res.status(404).json({ error: 'workspace_member_not_found' });
    return;
  }

  if (error instanceof Error && error.message === 'member_seat_limit_exceeded') {
    res.status(429).json({ error: 'member_seat_limit_exceeded' });
    return;
  }

  if (error instanceof Error && error.message === 'last_owner_required') {
    res.status(409).json({ error: 'last_owner_required' });
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
  const authEnvironment = readAuthEnvironment(options.authEnvironment);
  const routeOptions = { ...options, authEnvironment, auth: options.auth ?? createRequestAuth(pool, authEnvironment) };
  const relayRouteOptions: Parameters<typeof createRelayRoutes>[0] = {};
  const relayRouteService = options.relayRouteService ?? options.relayService;
  if (relayRouteService) relayRouteOptions.relayService = relayRouteService;
  if (options.relayServer) relayRouteOptions.relayServer = options.relayServer;
  const localMode = options.localMode ?? Boolean(options.localFileService);
  app.use(createCorsMiddleware({
    ...(options.allowedOrigins ? { allowedOrigins: options.allowedOrigins } : {}),
    enforceAllowedOrigins: options.enforceAllowedOrigins ?? false,
  }));
  app.use(express.json({ limit: '2mb' }));
  if (options.providerHttpProxy) app.use(options.providerHttpProxy);

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
    // Local-file compatibility only: index.ts wires this to in-memory relay state, not the frozen DB-backed relay_* tables.
    app.use('/api', createRelayRoutes(relayRouteOptions));
  } else {
    app.use('/api', createAuthRoutes(pool, {
      devAuthEnabled: authEnvironment.devAuth,
      cookieSecure: authEnvironment.nodeEnv === 'production',
      ...(authEnvironment.oidc ? { oidcConfig: authEnvironment.oidc } : {}),
      ...(options.oidcExchange ? { oidcExchange: options.oidcExchange } : {}),
    }));
    app.use('/api', createWorkspaceRoutes(pool));
    app.use('/api', createAccessRoutes(pool, routeOptions));
    if (options.enableLegacyDocAiRoutes ?? authEnvironment.legacyHostedDocAi) app.use('/api', createDocAiRoutes(pool, liveWriter, routeOptions));
    app.use('/api', createImportExportRoutes(pool, routeOptions));
    app.use('/api', createLocalFileRoutes(options.localFileService, routeOptions));
    app.use('/api', createLocalConflictRoutes(options.localFileService, routeOptions));
    app.use('/api', createCollabSessionRoutes(pool, routeOptions));
    app.use('/api', createVersionRoutes(pool, liveWriter, routeOptions));
  }

  mountStaticWeb(app, options.staticWeb);
  app.use(errorHandler);

  return app;
}
