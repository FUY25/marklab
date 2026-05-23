import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express, { type ErrorRequestHandler, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { ZodError } from 'zod';
import type { DbPool } from '../db/client';
import { createAccessRoutes } from '../routes/access-routes';
import { createAuthRoutes } from '../routes/auth-routes';
import { createBillingRoutes } from '../routes/billing-routes';
import { createCloudCopyRoutes } from '../routes/cloud-copy-routes';
import { createCollabSessionRoutes } from '../routes/collab-session-routes';
import { createDocAiRoutes } from '../routes/doc-ai-routes';
import { createImportExportRoutes } from '../routes/import-export-routes';
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
import type { ProviderTokenService } from '../provider/ysweet-token-service';
import { authenticateRequestUser } from '../services/user-service';
import { requireUserDocumentAccess } from '../services/control-plane-access';
import type { OidcAuthConfig, OidcExchange } from '../services/oidc-service';

export interface HttpAppOptions {
  flushCollabDocument?: (roomName: string) => Promise<void>;
  applyCollabDocumentState?: (
    roomName: string,
    yjsState: Uint8Array,
    options?: { expectedCurrentHash?: string },
  ) => Promise<Uint8Array | void>;
  verifyCollabDocumentState?: (roomName: string, options?: { expectedCurrentHash?: string }) => Promise<void>;
  closeCollabDocumentConnections?: (roomName: string) => void;
  closeProviderDocConnections?: (providerDocIds: readonly string[]) => void;
  collabSnapshotService?: CollabSnapshotService;
  auth?: HttpRequestAuth;
  providerTokenService?: ProviderTokenService;
  providerHttpProxy?: RequestHandler;
  allowedOrigins?: readonly string[];
  enforceAllowedOrigins?: boolean;
  health?: HttpHealthOptions;
  enableLegacyDocAiRoutes?: boolean;
  staticCollabWeb?: StaticWebOptions;
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
  yjsState?: Uint8Array;
}

export interface CollabSnapshotService {
  readCurrentMarkdownSnapshot(input: { docId: string; branchId: string }): Promise<CollabMarkdownSnapshot | null>;
  applyMarkdownSnapshot?(input: { docId: string; branchId: string; markdown: string }): Promise<void>;
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

async function readHealth(pool: DbPool, input: HttpHealthOptions = {}) {
  const database = { required: Boolean(input.databaseRequired), ready: false, error: null as string | null };
  const schema = { required: Boolean(input.databaseRequired), ready: false, missing: [] as string[], error: null as string | null };
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
      ok: providerReadyForGate,
      process: { ready: true },
      database,
      schema,
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
          'document_branch_states',
          'document_branch_autosave_state',
          'collab_sessions',
          'provider_token_issuances',
          'provider_token_refreshes',
          'provider_doc_deletions',
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
    ok: database.ready && schema.ready && providerReadyForGate,
    process: { ready: true },
    database,
    schema,
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

  if (error instanceof Error && error.message === 'native_auth_state_required') {
    res.status(400).json({ error: 'native_auth_state_required' });
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

  if (error instanceof Error && error.message === 'workspace_billing_not_found') {
    res.status(404).json({ error: 'workspace_billing_not_found' });
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

  if (error instanceof Error && error.message.startsWith('missing_route_param:')) {
    res.status(400).json({ error: 'invalid_route' });
    return;
  }

  res.status(500).json({ error: 'internal_error' });
};

function mountStaticCollabWeb(app: express.Express, staticCollabWeb: StaticWebOptions | undefined): void {
  if (!staticCollabWeb?.distDir || !existsSync(staticCollabWeb.distDir)) return;

  const indexHtml = join(staticCollabWeb.distDir, 'index.html');
  if (!existsSync(indexHtml)) return;

  app.use('/collab-web', express.static(staticCollabWeb.distDir, { index: false }));
  app.get(/^\/(?:collab(?:\/.*)?|workspaces\/[^/]+\/settings\/?|signin\/?|auth\/callback\/?)$/u, (_req, res) => {
    res.sendFile(indexHtml);
  });
}

export function createHttpApp(pool: DbPool, liveWriter: LiveMarkdownWriter, options: HttpAppOptions = {}) {
  const app = express();
  const authEnvironment = readAuthEnvironment(options.authEnvironment);
  const routeOptions = { ...options, authEnvironment, auth: options.auth ?? createRequestAuth(pool, authEnvironment) };
  app.use(createCorsMiddleware({
    ...(options.allowedOrigins ? { allowedOrigins: options.allowedOrigins } : {}),
    enforceAllowedOrigins: options.enforceAllowedOrigins ?? false,
  }));
  app.use(express.json({ limit: '2mb' }));
  if (options.providerHttpProxy) app.use(options.providerHttpProxy);

  app.get('/healthz', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const health = await readHealth(pool, options.health);
      res.status(health.ok ? 200 : 503).json(health);
    } catch (error) {
      next(error);
    }
  });

  app.use('/api', createAuthRoutes(pool, {
    devAuthEnabled: authEnvironment.devAuth,
    cookieSecure: authEnvironment.nodeEnv === 'production',
    ...(authEnvironment.oidc ? { oidcConfig: authEnvironment.oidc } : {}),
    ...(options.oidcExchange ? { oidcExchange: options.oidcExchange } : {}),
  }));
  app.use('/api', createWorkspaceRoutes(pool));
  app.use('/api', createBillingRoutes(pool));
  app.use('/api', createAccessRoutes(pool, routeOptions));
  app.use('/api', createCloudCopyRoutes(pool, routeOptions));
  if (options.enableLegacyDocAiRoutes ?? authEnvironment.legacyHostedDocAi) app.use('/api', createDocAiRoutes(pool, liveWriter, routeOptions));
  app.use('/api', createImportExportRoutes(pool, routeOptions));
  app.use('/api', createCollabSessionRoutes(pool, routeOptions));
  app.use('/api', createVersionRoutes(pool, liveWriter, routeOptions));

  mountStaticCollabWeb(app, options.staticCollabWeb);
  app.use(errorHandler);

  return app;
}
