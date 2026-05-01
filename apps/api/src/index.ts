import http from 'node:http';
import { randomBytes } from 'node:crypto';
import crossws from 'crossws/adapters/node';
import type { WebSocketLike } from '@hocuspocus/server';
import { createCollabServer } from './collab/server';
import { createPool, type DbPool } from './db/client';
import { createHttpApp } from './http/app';
import { createLocalFileServiceWithOptions } from './local/local-file-service';
import { isLoopbackLocalRequest } from './routes/local-file-routes';
import { createPostgresLiveMarkdownWriter } from './services/postgres-live-writer';

const port = Number(process.env.PORT ?? 3001);
const localMode = Boolean(process.env.MARKLAB_LOCAL_FILE);
const host = process.env.MARKLAB_HOST ?? process.env.HOST ?? (localMode ? '127.0.0.1' : undefined);

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
  const pool = process.env.DATABASE_URL || !localFileService ? createPool() : createLocalOnlyPool();
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
    ...(localFileService
      ? {
          localFileService,
          localDaemonToken: localDaemonToken ?? '',
          localMode: true,
        }
      : {}),
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
      if (localFileService) {
        await collab.flushDocument(localFileService.roomName);
        localFileService.stopWatcher();
      }
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
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
    localFileService?.startWatcher({
      flushRoom: collab.flushDocument,
      applyRoomState: collab.applyDocumentState,
    });
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
