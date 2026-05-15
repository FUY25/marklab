import http from 'node:http';
import { randomBytes } from 'node:crypto';
import crossws from 'crossws/adapters/node';
import type { WebSocketLike } from '@hocuspocus/server';
import { createCollabServer } from './collab/server';
import { loadApiEnv } from './config/env';
import { createPool, type DbPool } from './db/client';
import { createHttpApp } from './http/app';
import { createLocalFileServiceWithOptions } from './local/local-file-service';
import { createLocalRelayHostController, createLocalRelayMirrorController } from './local/local-relay-client';
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
import { createRemoteRelayRoomService } from './relay/relay-remote-service';
import { createInMemoryRelayRoomService } from './relay/relay-room-service';
import { createRelayServer } from './relay/relay-server';
import { isLoopbackLocalRequest } from './routes/local-file-routes';
import { createPostgresLiveMarkdownWriter } from './services/postgres-live-writer';

const env = loadApiEnv();
const port = env.port;
const localMode = Boolean(process.env.MARKLAB_LOCAL_FILE);
const host = process.env.MARKLAB_HOST ?? process.env.HOST ?? (localMode ? '127.0.0.1' : undefined);

function isLoopbackPublicApiUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch {
    return false;
  }
}

function createLocalOnlyPool(): DbPool {
  async function unavailable(): Promise<never> {
    throw new Error('database_not_configured');
  }

  return {
    query: unavailable,
    connect: unavailable,
  };
}

async function main() {
  const localFileOptions = process.env.MARKLAB_LOCAL_METADATA_PATH
    ? { metadataPath: process.env.MARKLAB_LOCAL_METADATA_PATH }
    : {};
  const localFileService = process.env.MARKLAB_LOCAL_FILE
    ? await createLocalFileServiceWithOptions(process.env.MARKLAB_LOCAL_FILE, localFileOptions)
    : undefined;
  const localDaemonToken = localFileService
    ? process.env.MARKLAB_LOCAL_TOKEN ?? randomBytes(24).toString('base64url')
    : undefined;
  const useDatabase = !localFileService || process.env.MARKLAB_LOCAL_USE_DATABASE === 'true';
  const pool = useDatabase ? createPool(env.databaseUrl) : createLocalOnlyPool();
  const ysweetProviderConfig = !localFileService && env.ysweetProviderMode !== 'disabled'
    ? loadYSweetProviderProcessConfig(process.env, {
        requireAuth: env.mode === 'production' && process.env.MARKLAB_LOCAL_PRODUCTION_SMOKE !== 'true' && env.ysweetProviderMode === 'process',
        requireServerToken: env.mode === 'production' && process.env.MARKLAB_LOCAL_PRODUCTION_SMOKE !== 'true',
        requireStorePath: env.mode === 'production' && process.env.MARKLAB_LOCAL_PRODUCTION_SMOKE !== 'true' && env.ysweetProviderMode === 'process',
      })
    : undefined;
  const ysweetProvider = ysweetProviderConfig ? startYSweetProviderProcess(ysweetProviderConfig) : undefined;
  const providerTokenService =
    !localFileService && ysweetProviderConfig?.connectionString
      ? createYSweetTokenService({ connectionString: ysweetProviderConfig.connectionString })
      : undefined;
  const collabSnapshotService =
    providerTokenService && ysweetProviderConfig?.connectionString
      ? createYSweetSnapshotService({ pool, connectionString: ysweetProviderConfig.connectionString })
      : undefined;
  const localHostedRelay = Boolean(localFileService && env.publicApiUrl && !isLoopbackPublicApiUrl(env.publicApiUrl));
  const hostedRelayService = localHostedRelay ? createRemoteRelayRoomService({ publicApiUrl: env.publicApiUrl }) : undefined;
  const localRelayService =
    localFileService && !localHostedRelay && process.env.MARKLAB_ENABLE_RELAY === 'true'
      ? createInMemoryRelayRoomService()
      : undefined;
  const relayService = hostedRelayService ?? localRelayService;
  const relay = localRelayService
    ? createRelayServer(localRelayService, {
        hostLeaseMs: env.relayHostLeaseSeconds * 1000,
        maxConnectionsPerRoom: env.relayMaxRoomConnections,
        maxMessageBytes: env.relayMaxMessageBytes,
        ...(env.mode === 'production' ? { allowedOrigins: env.allowedOrigins } : {}),
      })
    : undefined;
  const shouldStartLocalRelayMirror = Boolean(
    localFileService && process.env.MARKLAB_RELAY_ROOM_ID && process.env.MARKLAB_RELAY_TOKEN,
  );
  const localRelayHost =
    localFileService && relayService && !shouldStartLocalRelayMirror
      ? createLocalRelayHostController({
          localFileService,
          relayService,
          relayWebSocketUrl: process.env.MARKLAB_RELAY_WS_URL ?? `ws://127.0.0.1:${port}/relay`,
          publicWebUrl: env.publicWebUrl,
          publicApiUrl: env.publicApiUrl,
          publicRelayWebSocketUrl: env.publicRelayWebSocketUrl,
        })
      : undefined;
  const localRelayMirror =
    shouldStartLocalRelayMirror && localFileService && process.env.MARKLAB_RELAY_ROOM_ID && process.env.MARKLAB_RELAY_TOKEN
      ? createLocalRelayMirrorController({
          localFileService,
          relayRoomId: process.env.MARKLAB_RELAY_ROOM_ID,
          token: process.env.MARKLAB_RELAY_TOKEN,
          relayWebSocketUrl: process.env.MARKLAB_RELAY_WS_URL ?? `ws://127.0.0.1:${port}/relay`,
          clientId: process.env.MARKLAB_RELAY_CLIENT_ID ?? `mirror_${randomBytes(12).toString('base64url')}`,
          ...(process.env.MARKLAB_RELAY_DISPLAY_NAME ? { displayName: process.env.MARKLAB_RELAY_DISPLAY_NAME } : {}),
        })
      : undefined;
  const collab = createCollabServer(
    pool,
    localFileService
      ? {
          localStore: localFileService,
          localDaemonToken: localDaemonToken ?? '',
          localOnly: true,
        }
      : {},
  );
  const liveWriter = createPostgresLiveMarkdownWriter(pool);
  const app = createHttpApp(pool, liveWriter, {
    flushCollabDocument: collab.flushDocument,
    applyCollabDocumentState: collab.applyDocumentState,
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
    ...(localFileService
      ? {
          localFileService,
          localDaemonToken: localDaemonToken ?? '',
          localMode: true,
          ...(localRelayHost ? { localRelayHost } : {}),
          ...(localRelayMirror ? { localRelayMirror } : {}),
        }
      : {}),
    ...(relayService ? { relayRouteService: relayService } : {}),
    ...(localRelayService ? { relayService: localRelayService } : {}),
    ...(relay ? { relayServer: relay } : {}),
    allowedOrigins: env.allowedOrigins,
    enforceAllowedOrigins: env.mode === 'production',
    ...(process.env.MARKLAB_WEB_DIST_DIR ? { staticWeb: { distDir: process.env.MARKLAB_WEB_DIST_DIR } } : {}),
    health: {
      databaseRequired: env.mode === 'production',
      relayRequired: Boolean(relayService),
      relayReady: localHostedRelay,
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
        'relay_rooms',
        'relay_access_grants',
        'relay_access_sessions',
        'document_branch_states',
        'collab_sessions',
        'provider_token_issuances',
        'provider_token_refreshes',
      ],
      schemaColumns: {
        documents: ['workspace_id', 'folder_id'],
        document_access_grants: ['workspace_id', 'folder_id', 'created_by_user_id', 'grant_kind'],
        document_access_sessions: ['doc_id', 'branch_id', 'actor_kind', 'actor_id'],
        document_branch_states: ['provider_doc_id', 'provider_doc_seeded_at'],
        collab_sessions: ['refresh_token_hash', 'is_guest', 'status', 'expires_at'],
        provider_token_issuances: ['workspace_id', 'folder_id', 'actor_type', 'actor_id', 'actor_grant_id', 'status', 'provider_error'],
        provider_token_refreshes: ['session_id', 'issued_at', 'expires_at', 'denied_at', 'deny_reason'],
      },
    },
  });
  const httpServer = http.createServer(app);
  let isShuttingDown = false;
  let localRelayMirrorRetryTimer: NodeJS.Timeout | null = null;

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
    if (request.url?.startsWith('/relay')) {
      if (!relay) {
        socket.destroy();
        return;
      }
      relay.handleUpgrade(request, socket, head);
      return;
    }

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

    if (localFileService && !isLoopbackLocalRequest(request.headers)) {
      socket.destroy();
      return;
    }

    ws.handleUpgrade(request, socket, head);
  });

  async function shutdown(exitCode: number): Promise<void> {
    if (isShuttingDown) return;
    isShuttingDown = true;
    try {
      if (localRelayMirrorRetryTimer) clearTimeout(localRelayMirrorRetryTimer);
      localRelayMirrorRetryTimer = null;
      if (localFileService) {
        await collab.flushDocument(localFileService.roomName);
        localFileService.stopWatcher();
        localRelayHost?.stop();
        localRelayMirror?.stop();
      }
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
      await relay?.close();
      await stopYSweetProviderProcess(ysweetProvider);
      await (collab.server as unknown as { destroy?: () => Promise<void> | void }).destroy?.();
    } catch (error) {
      console.error(error);
      process.exit(exitCode === 0 ? 1 : exitCode);
      return;
    }
    process.exit(exitCode);
  }

  function startLocalRelayMirrorWithRetry(): void {
    if (!localRelayMirror || isShuttingDown) return;
    void localRelayMirror.start().catch((error: unknown) => {
      if (isShuttingDown) return;
      console.error(error);
      localRelayMirror.stop();
      localRelayMirrorRetryTimer = setTimeout(startLocalRelayMirrorWithRetry, 2000);
      localRelayMirrorRetryTimer.unref();
    });
  }

  process.on('SIGINT', () => {
    void shutdown(130);
  });
  process.on('SIGTERM', () => {
    void shutdown(0);
  });

  httpServer.listen(port, host, () => {
    localFileService?.startWatcher({
      flushRoom: collab.flushDocument,
      applyRoomState: collab.applyDocumentState,
    });
    void localRelayHost?.resumeHosted().catch((error: unknown) => {
      console.error(error);
    });
    startLocalRelayMirrorWithRetry();
    console.log(`api listening on ${host ?? '0.0.0.0'}:${port}`);
    if (localFileService) {
      console.log(`local file: ${localFileService.getSummary().absolutePath}`);
      console.log(`local room: ${localFileService.roomName}`);
    }
  });
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
