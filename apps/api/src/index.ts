import http from 'node:http';
import crossws from 'crossws/adapters/node';
import type { WebSocketLike } from '@hocuspocus/server';
import { createCollabServer } from './collab/server';
import { createPool } from './db/client';
import { createHttpApp } from './http/app';
import { createPostgresLiveMarkdownWriter } from './services/postgres-live-writer';

const port = Number(process.env.PORT ?? 3001);
const pool = createPool();
const collab = createCollabServer(pool);
const liveWriter = createPostgresLiveMarkdownWriter(pool);
const app = createHttpApp(pool, liveWriter, {
  flushCollabDocument: collab.flushDocument,
  applyCollabDocumentState: collab.applyDocumentState,
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
  console.log(`api listening on :${port}`);
});
