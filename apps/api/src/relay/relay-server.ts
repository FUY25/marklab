import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import WebSocket, { WebSocketServer } from 'ws';
import type { RelayRoomService, RelayAccessRole, RelayClientKind } from './relay-room-service';
import {
  assertRelayMessageBytes,
  assertRelayRoomConnectionLimit,
  relayRawDataByteLength,
  resolveRelayLimits,
} from './relay-limits';
import {
  noopRelayObservabilitySink,
  type RelayObservabilitySink,
} from './relay-observability';

type RelayConnectionRole = 'host' | RelayAccessRole;

interface RelayConnection {
  socket: WebSocket;
  relayRoomId: string;
  role: RelayConnectionRole;
  grantId: string | null;
  sessionId: string | null;
  clientKind: RelayClientKind;
  hostSessionId: string | null;
  lastSeenAt: number;
}

interface PendingProposal {
  proposalId: string;
  relayRoomId: string;
  proposer: RelayConnection;
  updateBase64: string;
  replace: boolean;
  timer: NodeJS.Timeout;
}

export interface RelayServerHandle {
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void;
  disconnectGrant(grantId: string): void;
  closeRoom(relayRoomId: string): void;
  close(): Promise<void>;
  readonly connectionCount: number;
}

export interface CreateRelayServerOptions {
  proposalTimeoutMs?: number;
  hostLeaseMs?: number;
  maxMessageBytes?: number;
  maxConnectionsPerRoom?: number;
  allowedOrigins?: readonly string[];
  observability?: RelayObservabilitySink;
}

type RelayClientMessage =
  | {
      type: 'hello';
      relayRoomId: string;
      token?: string;
      clientId?: string;
      clientKind?: RelayClientKind;
      displayName?: string;
      hostSessionId?: string;
      hostToken?: string;
      asHost?: boolean;
    }
  | { type: 'propose_update'; proposalId?: string; updateBase64: string; replace?: boolean }
  | { type: 'awareness_update'; updateBase64: string }
  | { type: 'host_ack'; proposalId: string; yjsStateBase64: string; sharedHash: string }
  | { type: 'host_reject'; proposalId: string; reason?: string }
  | { type: 'host_update'; yjsStateBase64: string; sharedHash: string }
  | { type: 'ping' };

function decodeJsonMessage(data: WebSocket.RawData): RelayClientMessage | null {
  try {
    const raw = Array.isArray(data)
      ? Buffer.concat(data).toString('utf8')
      : data instanceof ArrayBuffer
        ? Buffer.from(data).toString('utf8')
        : Buffer.from(data as Buffer).toString('utf8');
    return JSON.parse(raw) as RelayClientMessage;
  } catch {
    return null;
  }
}

function sendJson(socket: WebSocket, message: Record<string, unknown>): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(message));
}

function closeSocket(socket: WebSocket, code: number, reason: string): void {
  if (socket.readyState !== WebSocket.OPEN && socket.readyState !== WebSocket.CONNECTING) return;
  socket.close(code, reason);
}

function requireString(value: unknown, error: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(error);
  return value;
}

export function createRelayServer(service: RelayRoomService, options: CreateRelayServerOptions = {}): RelayServerHandle {
  const limits = resolveRelayLimits(options);
  const wss = new WebSocketServer({ noServer: true, maxPayload: limits.maxMessageBytes });
  const proposalTimeoutMs = options.proposalTimeoutMs ?? 8000;
  const hostLeaseMs = options.hostLeaseMs ?? 30000;
  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  const observability = options.observability ?? noopRelayObservabilitySink;
  const connections = new Set<RelayConnection>();
  const pendingByProposalId = new Map<string, PendingProposal>();

  function connectionsForRoom(relayRoomId: string): RelayConnection[] {
    return [...connections].filter((connection) => connection.relayRoomId === relayRoomId);
  }

  function hostForRoom(relayRoomId: string): RelayConnection | null {
    return connectionsForRoom(relayRoomId).find((connection) => connection.role === 'host') ?? null;
  }

  function pendingForRoom(relayRoomId: string): PendingProposal | null {
    return [...pendingByProposalId.values()].find((pending) => pending.relayRoomId === relayRoomId) ?? null;
  }

  function broadcast(relayRoomId: string, message: Record<string, unknown>): void {
    for (const connection of connectionsForRoom(relayRoomId)) {
      sendJson(connection.socket, message);
    }
  }

  function broadcastExcept(relayRoomId: string, excluded: RelayConnection, message: Record<string, unknown>): void {
    for (const connection of connectionsForRoom(relayRoomId)) {
      if (connection === excluded) continue;
      sendJson(connection.socket, message);
    }
  }

  function rejectPending(pending: PendingProposal, reason: string): void {
    clearTimeout(pending.timer);
    pendingByProposalId.delete(pending.proposalId);
    observability.increment('write_rejected', {
      relayRoomId: pending.relayRoomId,
      grantId: pending.proposer.grantId,
      sessionId: pending.proposer.sessionId,
      role: pending.proposer.role,
      reason,
    });
    sendJson(pending.proposer.socket, {
      type: 'rejected',
      proposalId: pending.proposalId,
      reason,
    });
  }

  function rejectPendingForHost(relayRoomId: string, reason: string): void {
    for (const pending of [...pendingByProposalId.values()]) {
      if (pending.relayRoomId === relayRoomId) rejectPending(pending, reason);
    }
  }

  function removeConnection(connection: RelayConnection, markHostOffline: boolean): void {
    connections.delete(connection);
    if (connection.role !== 'host') return;
    rejectPendingForHost(connection.relayRoomId, 'host_offline');
    if (markHostOffline) {
      observability.increment('host_lease_offline', {
        relayRoomId: connection.relayRoomId,
        sessionId: connection.hostSessionId,
      });
      void service.markHostOffline(connection.relayRoomId, connection.hostSessionId).catch(() => undefined);
      broadcast(connection.relayRoomId, { type: 'host_status', hostOnline: false });
    }
  }

  async function handleHello(socket: WebSocket, message: Extract<RelayClientMessage, { type: 'hello' }>): Promise<void> {
    const relayRoomId = requireString(message.relayRoomId, 'missing_relay_room_id');
    if (message.asHost) {
      const hostSessionId = requireString(message.hostSessionId, 'missing_host_session_id');
      const hostToken = requireString(message.hostToken, 'missing_host_token');
      await service.verifyHost(relayRoomId, hostToken);
      const existingHost = hostForRoom(relayRoomId);
      if (existingHost) removeConnection(existingHost, false);
      const room = await service.markHostOnline(relayRoomId, hostSessionId);
      assertRelayRoomConnectionLimit(connectionsForRoom(relayRoomId).length, limits.maxConnectionsPerRoom);
      const connection: RelayConnection = {
        socket,
        relayRoomId,
        role: 'host',
        grantId: null,
        sessionId: null,
        clientKind: 'daemon',
        hostSessionId,
        lastSeenAt: Date.now(),
      };
      connections.add(connection);
      observability.increment('host_lease_online', { relayRoomId, sessionId: hostSessionId, clientKind: 'daemon' });
      sendJson(socket, {
        type: 'hello_ack',
        role: 'host',
        relayRoomId,
        hostOnline: true,
        sharedRevision: room.sharedRevision,
        lastSharedHash: room.lastSharedHash,
        yjsStateBase64: room.lastEphemeralYjsState ? Buffer.from(room.lastEphemeralYjsState).toString('base64') : null,
      });
      broadcast(relayRoomId, { type: 'host_status', hostOnline: true });
      return;
    }

    const token = requireString(message.token, 'missing_token');
    const access = await service.verifyAccess({ relayRoomId, token, operation: 'read' });
    observability.increment('grant_validation', {
      relayRoomId,
      grantId: access.grantId,
      role: access.role,
      clientKind: message.clientKind ?? 'browser',
    });
    assertRelayRoomConnectionLimit(connectionsForRoom(relayRoomId).length, limits.maxConnectionsPerRoom);
    let sessionId: string | null = null;
    if (message.clientId) {
      const session = await service.createOrUpdateSession({
        relayRoomId,
        grantId: access.grantId,
        clientId: message.clientId,
        clientKind: message.clientKind ?? 'browser',
        displayName: message.displayName ?? '',
      });
      sessionId = session.sessionId;
    }
    const connection: RelayConnection = {
      socket,
      relayRoomId,
      role: access.role,
      grantId: access.grantId,
      sessionId,
      clientKind: message.clientKind ?? 'browser',
      hostSessionId: null,
      lastSeenAt: Date.now(),
    };
    connections.add(connection);
    sendJson(socket, {
      type: 'hello_ack',
      role: access.role,
      relayRoomId,
      grantId: access.grantId,
      sessionId,
      canWrite: access.canWrite,
      hostOnline: access.hostOnline && Boolean(hostForRoom(relayRoomId)),
      hostSessionId: access.hostSessionId,
      sharedRevision: access.sharedRevision,
      lastSharedHash: access.lastSharedHash,
      yjsStateBase64: access.lastEphemeralYjsState ? Buffer.from(access.lastEphemeralYjsState).toString('base64') : null,
    });
  }

  function connectionForSocket(socket: WebSocket): RelayConnection | null {
    return [...connections].find((connection) => connection.socket === socket) ?? null;
  }

  async function handleProposal(connection: RelayConnection, message: Extract<RelayClientMessage, { type: 'propose_update' }>): Promise<void> {
    if (connection.role !== 'edit') {
      observability.increment('write_rejected', {
        relayRoomId: connection.relayRoomId,
        grantId: connection.grantId,
        sessionId: connection.sessionId,
        role: connection.role,
        reason: 'forbidden',
      });
      sendJson(connection.socket, { type: 'rejected', reason: 'forbidden' });
      return;
    }

    const host = hostForRoom(connection.relayRoomId);
    const room = await service.getRoom(connection.relayRoomId);
    if (!host || room.state !== 'host_online' || Date.now() - host.lastSeenAt > hostLeaseMs) {
      const reason = host && Date.now() - host.lastSeenAt > hostLeaseMs ? 'host_lease_expired' : 'host_offline';
      observability.increment('write_rejected', {
        relayRoomId: connection.relayRoomId,
        grantId: connection.grantId,
        sessionId: connection.sessionId,
        role: connection.role,
        reason,
      });
      sendJson(connection.socket, { type: 'rejected', reason });
      return;
    }

    const proposalId = message.proposalId || randomUUID();
    if (pendingForRoom(connection.relayRoomId)) {
      observability.increment('write_rejected', {
        relayRoomId: connection.relayRoomId,
        grantId: connection.grantId,
        sessionId: connection.sessionId,
        role: connection.role,
        reason: 'proposal_in_flight',
      });
      sendJson(connection.socket, { type: 'rejected', proposalId, reason: 'proposal_in_flight' });
      return;
    }
    const pending: PendingProposal = {
      proposalId,
      relayRoomId: connection.relayRoomId,
      proposer: connection,
      updateBase64: message.updateBase64,
      replace: Boolean(message.replace),
      timer: setTimeout(() => {
        const current = pendingByProposalId.get(proposalId);
        if (current) rejectPending(current, 'host_offline');
      }, proposalTimeoutMs),
    };
    pending.timer.unref();
    pendingByProposalId.set(proposalId, pending);
    sendJson(host.socket, {
      type: 'proposal',
      proposalId,
      fromSessionId: connection.sessionId,
      updateBase64: message.updateBase64,
      replace: pending.replace,
    });
  }

  async function acceptHostUpdate(
    connection: RelayConnection,
    yjsStateBase64: string,
    sharedHash: string,
    proposalId: string | null,
  ): Promise<void> {
    if (connection.role !== 'host') {
      observability.increment('write_rejected', {
        relayRoomId: connection.relayRoomId,
        sessionId: connection.sessionId,
        role: connection.role,
        reason: 'forbidden',
      });
      sendJson(connection.socket, { type: 'rejected', reason: 'forbidden' });
      return;
    }
    const pending = proposalId ? pendingByProposalId.get(proposalId) : null;
    if (proposalId && (!pending || pending.relayRoomId !== connection.relayRoomId)) {
      sendJson(connection.socket, { type: 'error', error: 'unknown_proposal' });
      return;
    }
    const yjsState = new Uint8Array(Buffer.from(yjsStateBase64, 'base64'));
    const room = await service.acceptSharedState({
      relayRoomId: connection.relayRoomId,
      yjsState,
      sharedHash,
    });
    if (pending) {
      clearTimeout(pending.timer);
      pendingByProposalId.delete(pending.proposalId);
    }
    broadcast(connection.relayRoomId, {
      type: 'accepted_update',
      proposalId,
      updateBase64: yjsStateBase64,
      replace: pending?.replace ?? false,
      sharedRevision: room.sharedRevision,
      sharedHash: room.lastSharedHash,
      hostSessionId: connection.hostSessionId,
      hostOnline: true,
    });
  }

  function handleHostReject(connection: RelayConnection, message: Extract<RelayClientMessage, { type: 'host_reject' }>): void {
    if (connection.role !== 'host') return;
    const pending = pendingByProposalId.get(message.proposalId);
    if (!pending) return;
    rejectPending(pending, message.reason || 'host_write_failed');
  }

  function handleAwarenessUpdate(connection: RelayConnection, message: Extract<RelayClientMessage, { type: 'awareness_update' }>): void {
    const updateBase64 = requireString(message.updateBase64, 'missing_awareness_update');
    broadcastExcept(connection.relayRoomId, connection, {
      type: 'awareness_update',
      fromSessionId: connection.sessionId,
      updateBase64,
    });
  }

  async function handleMessage(socket: WebSocket, rawData: WebSocket.RawData): Promise<void> {
    try {
      assertRelayMessageBytes(rawData, limits.maxMessageBytes);
    } catch {
      const connection = connectionForSocket(socket);
      observability.increment('oversized_message', {
        relayRoomId: connection?.relayRoomId ?? null,
        grantId: connection?.grantId ?? null,
        sessionId: connection?.sessionId ?? null,
        messageBytes: relayRawDataByteLength(rawData),
      });
      closeSocket(socket, 1009, 'message_too_large');
      return;
    }
    const message = decodeJsonMessage(rawData);
    if (!message) {
      sendJson(socket, { type: 'error', error: 'invalid_message' });
      return;
    }

    try {
      if (message.type === 'hello') {
        await handleHello(socket, message);
        return;
      }

      const connection = connectionForSocket(socket);
      if (!connection) {
        sendJson(socket, { type: 'error', error: 'not_authenticated' });
        return;
      }
      connection.lastSeenAt = Date.now();

      if (message.type === 'ping') {
        if (connection.role === 'host' && connection.hostSessionId) {
          observability.increment('host_lease_online', {
            relayRoomId: connection.relayRoomId,
            sessionId: connection.hostSessionId,
          });
          void service.markHostOnline(connection.relayRoomId, connection.hostSessionId).catch(() => undefined);
        }
        sendJson(socket, { type: 'pong' });
        return;
      }
      if (message.type === 'propose_update') {
        await handleProposal(connection, message);
        return;
      }
      if (message.type === 'awareness_update') {
        handleAwarenessUpdate(connection, message);
        return;
      }
      if (message.type === 'host_ack') {
        await acceptHostUpdate(connection, message.yjsStateBase64, message.sharedHash, message.proposalId);
        return;
      }
      if (message.type === 'host_reject') {
        handleHostReject(connection, message);
        return;
      }
      if (message.type === 'host_update') {
        await acceptHostUpdate(connection, message.yjsStateBase64, message.sharedHash, null);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'relay_error';
      if (reason === 'room_connection_limit_exceeded') {
        observability.increment('room_connection_limit_rejected');
      }
      sendJson(socket, { type: 'error', error: reason });
    }
  }

  const leaseTimer = setInterval(() => {
    const now = Date.now();
    for (const connection of [...connections]) {
      if (connection.role !== 'host') continue;
      if (now - connection.lastSeenAt <= hostLeaseMs) continue;
      observability.increment('host_lease_expired', {
        relayRoomId: connection.relayRoomId,
        sessionId: connection.hostSessionId,
      });
      closeSocket(connection.socket, 4001, 'host_lease_expired');
      removeConnection(connection, true);
    }
  }, Math.max(1000, Math.floor(hostLeaseMs / 2)));
  leaseTimer.unref();

  wss.on('connection', (socket) => {
    socket.on('message', (data) => {
      void handleMessage(socket, data);
    });
    socket.on('close', () => {
      const connection = connectionForSocket(socket);
      if (connection) removeConnection(connection, true);
    });
    socket.on('error', () => {
      const connection = connectionForSocket(socket);
      if (connection) removeConnection(connection, true);
    });
  });

  return {
    handleUpgrade(request, socket, head) {
      if (allowedOrigins.size > 0) {
        const origin = request.headers.origin;
        if (!origin || !allowedOrigins.has(origin)) {
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
          socket.destroy();
          return;
        }
      }
      wss.handleUpgrade(request, socket, head, (websocket) => {
        wss.emit('connection', websocket, request);
      });
    },
    disconnectGrant(grantId) {
      observability.increment('grant_revoked', { grantId });
      for (const connection of [...connections]) {
        if (connection.grantId !== grantId) continue;
        closeSocket(connection.socket, 4003, 'grant_revoked');
        removeConnection(connection, false);
      }
    },
    closeRoom(relayRoomId) {
      observability.increment('room_closed', { relayRoomId });
      for (const connection of connectionsForRoom(relayRoomId)) {
        closeSocket(connection.socket, 4004, 'room_closed');
        removeConnection(connection, false);
      }
    },
    async close() {
      clearInterval(leaseTimer);
      for (const pending of [...pendingByProposalId.values()]) rejectPending(pending, 'relay_closed');
      for (const connection of [...connections]) {
        closeSocket(connection.socket, 1001, 'relay_closed');
        removeConnection(connection, false);
      }
      for (const socket of wss.clients) closeSocket(socket, 1001, 'relay_closed');
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
    },
    get connectionCount() {
      return connections.size;
    },
  };
}
