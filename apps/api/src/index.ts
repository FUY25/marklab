import http from 'node:http';
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
  proxyYSweetProviderHttpRequest,
  proxyYSweetProviderWebSocketUpgrade,
} from './provider/ysweet-provider-websocket-proxy';
import { createYSweetSnapshotService, createYSweetTokenService } from './provider/ysweet-token-service';
import { createPostgresLiveMarkdownWriter } from './services/postgres-live-writer';

const env = loadApiEnv();
const port = env.port;
const host = process.env.MARKLAB_HOST ?? process.env.HOST;

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
  const app = createHttpApp(pool, liveWriter, {
    flushCollabDocument: collab.flushDocument,
    applyCollabDocumentState: collab.applyDocumentState,
    verifyCollabDocumentState: collab.verifyDocumentState,
    closeCollabDocumentConnections: collab.closeDocumentConnections,
    ...(providerTokenService ? { providerTokenService } : {}),
    ...(ysweetProvider
      ? {
          providerHttpProxy: (req, res, next) => {
            if (!isYSweetProviderHttpPath(req.originalUrl ?? req.url)) {
              next();
              return;
            }
            proxyYSweetProviderHttpRequest(ysweetProvider.serverUrl, req, res);
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
        'collab_sessions',
        'provider_token_issuances',
        'provider_token_refreshes',
      ],
      schemaColumns: {
        documents: ['workspace_id', 'folder_id'],
        document_access_grants: ['workspace_id', 'folder_id', 'created_by_user_id', 'grant_kind'],
        document_access_sessions: ['doc_id', 'branch_id', 'actor_kind', 'actor_id'],
        subscriptions: ['billing_mode', 'external_customer_id', 'external_subscription_id', 'billing_metadata'],
        document_branch_states: ['provider_doc_id', 'provider_doc_seeded_at'],
        collab_sessions: ['refresh_token_hash', 'is_guest', 'status', 'expires_at'],
        provider_token_issuances: ['workspace_id', 'folder_id', 'actor_type', 'actor_id', 'actor_grant_id', 'status', 'provider_error'],
        provider_token_refreshes: ['session_id', 'issued_at', 'expires_at', 'denied_at', 'deny_reason'],
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
      proxyYSweetProviderWebSocketUpgrade(ysweetProvider.serverUrl, request, socket, head);
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
