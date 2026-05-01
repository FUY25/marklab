import http from 'node:http';
import crossws from 'crossws/adapters/node';
import type { WebSocketLike } from '@hocuspocus/server';
import { createCollabServer } from './collab/server';
import { createPool, type DbPool } from './db/client';
import { createHttpApp } from './http/app';
import { createLocalFileService } from './local/local-file-service';
import { createPostgresLiveMarkdownWriter } from './services/postgres-live-writer';

const port = Number(process.env.PORT ?? 3001);

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
  const localFileService = process.env.MARKLAB_LOCAL_FILE
    ? await createLocalFileService(process.env.MARKLAB_LOCAL_FILE)
    : undefined;
  const pool = process.env.DATABASE_URL || !localFileService ? createPool() : createLocalOnlyPool();
  const collab = createCollabServer(pool, localFileService ? { localStore: localFileService } : {});
  const liveWriter = createPostgresLiveMarkdownWriter(pool);
  const app = createHttpApp(pool, liveWriter, {
    flushCollabDocument: collab.flushDocument,
    applyCollabDocumentState: collab.applyDocumentState,
    closeCollabDocumentConnections: collab.closeDocumentConnections,
    ...(localFileService ? { localFileService } : {}),
  });
  const httpServer = http.createServer(app);

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

    ws.handleUpgrade(request, socket, head);
  });

  httpServer.listen(port, () => {
    localFileService?.startWatcher({
      flushRoom: collab.flushDocument,
      applyRoomState: collab.applyDocumentState,
    });
    console.log(`api listening on :${port}`);
    if (localFileService) {
      console.log(`local file: ${localFileService.getSummary().absolutePath}`);
    }
  });
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
