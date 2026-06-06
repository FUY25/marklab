import http from 'node:http';
import type { Duplex } from 'node:stream';
import crossws from 'crossws/adapters/node';
import type { WebSocketLike } from '@hocuspocus/server';
import { createCollabServer } from './collab/server';
import { loadApiEnv } from './config/env';
import { createPool } from './db/client';
import { createHttpApp } from './http/app';
import {
  loadYSweetProviderProcessConfig,
  readYSweetProviderHealth,
  startYSweetProviderProcess,
  stopYSweetProviderProcess,
} from './provider/ysweet-provider-process';
import {
  isYSweetProviderHttpPath,
  isYSweetProviderWebSocketOriginAllowed,
  isYSweetProviderWebSocketPath,
  extractYSweetProviderDocId,
  proxyYSweetProviderHttpRequest,
  proxyYSweetProviderWebSocketUpgrade,
} from './provider/ysweet-provider-websocket-proxy';
import { createYSweetSnapshotService, createYSweetTokenService } from './provider/ysweet-token-service';
import { PROVIDER_TOKEN_TTL_SECONDS } from './config/provider-token-policy';
import { isProviderDocDeleted } from './services/cloud-copy-service';
import { createPostgresLiveMarkdownWriter } from './services/postgres-live-writer';
import { startProviderAutosaveCheckpointJob } from './services/provider-autosave-service';
import { startDataLifecycleCleanupJob } from './services/lifecycle-cleanup-service';

const env = loadApiEnv();
const port = env.port;
const host = process.env.MARKLAB_HOST ?? process.env.HOST;
const providerAutosaveIdleGraceMs = 4 * 60 * 1000;

async function main() {
  const pool = createPool(env.databaseUrl);
  const ysweetProviderConfig = env.ysweetProviderMode !== 'disabled'
    ? loadYSweetProviderProcessConfig(process.env, {
        requireAuth: env.mode === 'production' && env.ysweetProviderMode === 'process',
        requireServerToken: env.mode === 'production',
        requireStorePath: env.mode === 'production' && env.ysweetProviderMode === 'process',
      })
    : undefined;
  const ysweetProvider = ysweetProviderConfig ? startYSweetProviderProcess(ysweetProviderConfig) : undefined;
  const providerTokenService =
    ysweetProviderConfig?.connectionString
      ? createYSweetTokenService({ connectionString: ysweetProviderConfig.connectionString })
      : undefined;
  const collabSnapshotService =
    providerTokenService && ysweetProviderConfig?.connectionString
      ? createYSweetSnapshotService({ pool, connectionString: ysweetProviderConfig.connectionString })
      : undefined;
  const collab = createCollabServer(pool);
  const liveWriter = createPostgresLiveMarkdownWriter(pool);
  const providerDocSockets = new Map<string, Set<Duplex>>();
  let providerDocAutosaveActiveUntilMs = 0;

  function noteProviderDocActivity(): void {
    providerDocAutosaveActiveUntilMs = Date.now() + providerAutosaveIdleGraceMs;
  }

  function hasRecentProviderDocActivity(): boolean {
    return providerDocSockets.size > 0 || Date.now() < providerDocAutosaveActiveUntilMs;
  }

  function trackProviderDocSocket(providerDocId: string, socket: Duplex): void {
    noteProviderDocActivity();
    let sockets = providerDocSockets.get(providerDocId);
    if (!sockets) {
      sockets = new Set();
      providerDocSockets.set(providerDocId, sockets);
    }
    sockets.add(socket);
    socket.on('close', () => {
      sockets?.delete(socket);
      if (sockets?.size === 0) providerDocSockets.delete(providerDocId);
      noteProviderDocActivity();
    });
  }

  function closeProviderDocConnections(providerDocIds: readonly string[]): void {
    let closed = false;
    for (const providerDocId of providerDocIds) {
      const sockets = providerDocSockets.get(providerDocId);
      if (!sockets) continue;
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      providerDocSockets.delete(providerDocId);
      closed = true;
    }
    if (closed) noteProviderDocActivity();
  }

  const providerAutosaveJob = collabSnapshotService
    ? startProviderAutosaveCheckpointJob({
        pool,
        collabSnapshotService,
        shouldRun: hasRecentProviderDocActivity,
        onError(error, branch) {
          console.warn('provider autosave checkpoint failed', branch, error);
        },
      })
    : undefined;
  const dataLifecycleCleanupJob = startDataLifecycleCleanupJob({
    pool,
    providerStorePath: ysweetProviderConfig?.storePath,
    providerDocDeletionGraceMs: (PROVIDER_TOKEN_TTL_SECONDS + 300) * 1000,
    onError(error) {
      console.warn('data lifecycle cleanup failed', error);
    },
  });

  const app = createHttpApp(pool, liveWriter, {
    flushCollabDocument: collab.flushDocument,
    applyCollabDocumentState: collab.applyDocumentState,
    verifyCollabDocumentState: collab.verifyDocumentState,
    closeCollabDocumentConnections: collab.closeDocumentConnections,
    closeProviderDocConnections,
    ...(providerTokenService ? { providerTokenService } : {}),
    ...(ysweetProvider
      ? {
          providerHttpProxy: async (req, res, next) => {
            try {
              if (!isYSweetProviderHttpPath(req.originalUrl ?? req.url)) {
                next();
                return;
              }
              const providerDocId = extractYSweetProviderDocId(req.originalUrl ?? req.url);
              if (providerDocId) noteProviderDocActivity();
              if (providerDocId && await isProviderDocDeleted(pool, providerDocId)) {
                res.status(410).json({ error: 'cloud_copy_deleted' });
                return;
              }
              proxyYSweetProviderHttpRequest(ysweetProvider.serverUrl, req, res);
            } catch (error) {
              next(error);
              return;
            }
          },
        }
      : {}),
    ...(collabSnapshotService ? { collabSnapshotService } : {}),
    allowedOrigins: env.allowedOrigins,
    enforceAllowedOrigins: env.mode === 'production',
    ...(process.env.MARKLAB_COLLAB_WEB_DIST_DIR ? { staticCollabWeb: { distDir: process.env.MARKLAB_COLLAB_WEB_DIST_DIR } } : {}),
    health: {
      databaseRequired: env.mode === 'production',
      providerRequired: Boolean(ysweetProvider),
      ...(ysweetProvider ? { providerHealth: () => readYSweetProviderHealth(ysweetProvider) } : {}),
      schemaTables: [
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
      ],
      schemaColumns: {
        oidc_login_states: ['native_callback', 'native_app_state', 'return_to'],
        documents: ['workspace_id', 'folder_id'],
        document_access_grants: ['workspace_id', 'folder_id', 'created_by_user_id', 'grant_kind'],
        document_access_sessions: ['doc_id', 'branch_id', 'actor_kind', 'actor_id'],
        subscriptions: ['billing_mode', 'external_customer_id', 'external_subscription_id', 'billing_metadata'],
        document_branch_states: ['provider_doc_id', 'provider_doc_seeded_at'],
        collab_sessions: ['refresh_token_hash', 'is_guest', 'status', 'expires_at'],
        provider_token_issuances: ['workspace_id', 'folder_id', 'actor_type', 'actor_id', 'actor_grant_id', 'status', 'provider_error'],
        provider_token_refreshes: ['session_id', 'issued_at', 'expires_at', 'denied_at', 'deny_reason'],
        provider_doc_deletions: ['cleanup_attempted_at', 'cleanup_completed_at', 'cleanup_error'],
      },
    },
  });
  const httpServer = http.createServer(app);
  let isShuttingDown = false;

  type ClientConnection = ReturnType<typeof collab.server.handleConnection>;
  type PeerWithConnection = {
    hocuspocusConnection?: ClientConnection;
  };

  const ws = crossws({
    hooks: {
      open(peer) {
        const peerWithConnection = peer as typeof peer & PeerWithConnection;
        peerWithConnection.hocuspocusConnection = collab.server.handleConnection(
          peer.websocket as unknown as WebSocketLike,
          peer.request as Request,
          {},
        );
      },
      message(peer, message) {
        const peerWithConnection = peer as typeof peer & PeerWithConnection;
        peerWithConnection.hocuspocusConnection?.handleMessage(message.uint8Array());
      },
      close(peer, event) {
        const peerWithConnection = peer as typeof peer & PeerWithConnection;
        peerWithConnection.hocuspocusConnection?.handleClose({
          code: event.code ?? 1000,
          reason: event.reason ?? '',
        });
      },
    },
  });

  httpServer.on('upgrade', (request, socket, head) => {
    if (isYSweetProviderWebSocketPath(request.url)) {
      if (
        !ysweetProvider
        || !isYSweetProviderWebSocketOriginAllowed({
          origin: request.headers.origin,
          allowedOrigins: env.allowedOrigins,
          enforceAllowedOrigins: env.mode === 'production',
        })
      ) {
        socket.destroy();
        return;
      }
      const providerDocId = extractYSweetProviderDocId(request.url);
      if (providerDocId) {
        void isProviderDocDeleted(pool, providerDocId).then((deleted) => {
          if (deleted) {
            socket.write('HTTP/1.1 410 Gone\r\ncontent-type: application/json\r\n\r\n{"error":"cloud_copy_deleted"}');
            socket.destroy();
            return;
          }
          trackProviderDocSocket(providerDocId, socket);
          proxyYSweetProviderWebSocketUpgrade(ysweetProvider.serverUrl, request, socket, head);
        }).catch(() => {
          socket.destroy();
        });
        return;
      }
      socket.destroy();
      return;
    }

    if (!request.url?.startsWith('/collab')) {
      socket.destroy();
      return;
    }

    ws.handleUpgrade(request, socket, head);
  });

  async function shutdown(exitCode: number): Promise<void> {
    if (isShuttingDown) return;
    isShuttingDown = true;
    try {
      providerAutosaveJob?.stop();
      dataLifecycleCleanupJob.stop();
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
      await stopYSweetProviderProcess(ysweetProvider);
      await (collab.server as unknown as { destroy?: () => Promise<void> | void }).destroy?.();
    } catch (error) {
      console.error(error);
      process.exit(exitCode === 0 ? 1 : exitCode);
      return;
    }
    process.exit(exitCode);
  }

  process.on('SIGINT', () => {
    void shutdown(130);
  });
  process.on('SIGTERM', () => {
    void shutdown(0);
  });

  httpServer.listen(port, host, () => {
    console.log(`api listening on ${host ?? '0.0.0.0'}:${port}`);
  });
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
