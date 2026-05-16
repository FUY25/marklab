import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { sha256Hex } from '@marklab/shared/src/hash';
import * as Y from 'yjs';
import { createLocalFileServiceWithOptions, type LocalFileService } from '../local/local-file-service';
import { createLocalRelayHostController, createLocalRelayMirrorController, type LocalRelayHostController, type LocalRelayMirrorController } from '../local/local-relay-client';
import { createInMemoryRelayRoomService, type RelayRoomService } from './relay-room-service';
import { createRelayServer, type CreateRelayServerOptions, type RelayServerHandle } from './relay-server';

interface RelayStack {
  service: RelayRoomService;
  relay: RelayServerHandle;
  server: http.Server;
  url: string;
  close(): Promise<void>;
}

const stacks: RelayStack[] = [];
const localControllers: Array<LocalRelayHostController | LocalRelayMirrorController> = [];
const localServices: LocalFileService[] = [];

function createState(text: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getText('prosemirror').insert(0, text);
  const state = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return state;
}

async function startRelayStack(options: CreateRelayServerOptions = {}): Promise<RelayStack> {
  const service = createInMemoryRelayRoomService();
  const relay = createRelayServer(service, { proposalTimeoutMs: 500, hostLeaseMs: 5000, ...options });
  const server = http.createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  server.on('upgrade', (request, socket, head) => {
    relay.handleUpgrade(request, socket, head);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing_port');
  const stack: RelayStack = {
    service,
    relay,
    server,
    url: `ws://127.0.0.1:${address.port}/relay`,
    close: async () => {
      await relay.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  stacks.push(stack);
  return stack;
}

afterEach(async () => {
  for (const controller of localControllers.splice(0)) controller.stop();
  for (const service of localServices.splice(0)) service.stopWatcher();
  await Promise.allSettled(stacks.splice(0).map((stack) => stack.close()));
});

function waitForOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
}

function nextMessage(socket: WebSocket, label = 'message'): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed_out_waiting_for_${label}`)), 1500);
    socket.once('message', (raw) => {
      clearTimeout(timer);
      resolve(JSON.parse(raw.toString()) as Record<string, unknown>);
    });
  });
}

async function nextMessageOfType(socket: WebSocket, type: string, label = type): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const message = await nextMessage(socket, label);
    if (message.type === type) return message;
  }
  throw new Error(`timed_out_waiting_for_${label}`);
}

async function expectNoMessage(socket: WebSocket, label: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage);
      resolve();
    }, 150);
    const onMessage = (raw: WebSocket.RawData) => {
      clearTimeout(timer);
      reject(new Error(`unexpected_${label}: ${raw.toString()}`));
    };
    socket.once('message', onMessage);
  });
}

async function waitForCondition(assertion: () => Promise<void> | void, timeoutMs = 3000): Promise<void> {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt <= timeoutMs) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('timed_out_waiting_for_condition');
}

async function createTempLocalService(markdown: string): Promise<{ file: string; metadataPath: string; service: LocalFileService }> {
  const directory = await mkdtemp(join(tmpdir(), 'marklab-relay-local-'));
  const file = join(directory, 'README.md');
  const metadataPath = join(directory, 'metadata.json');
  await writeFile(file, markdown, 'utf8');
  const service = await createLocalFileServiceWithOptions(file, { metadataPath });
  service.startWatcher({
    flushRoom: async () => undefined,
    applyRoomState: async () => undefined,
  });
  localServices.push(service);
  return { file, metadataPath, service };
}

async function localServiceState(markdown: string): Promise<Uint8Array> {
  const local = await createTempLocalService(markdown);
  const loaded = await local.service.loadRoomState(local.service.roomName);
  if (!loaded) throw new Error('missing_local_state');
  local.service.stopWatcher();
  return loaded.yjsState;
}

async function connectParticipant(
  url: string,
  input: { relayRoomId: string; token: string; clientId: string; displayName?: string },
): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await waitForOpen(socket);
  socket.send(
    JSON.stringify({
      type: 'hello',
      relayRoomId: input.relayRoomId,
      token: input.token,
      clientId: input.clientId,
      clientKind: 'browser',
      displayName: input.displayName ?? input.clientId,
    }),
  );
  const hello = await nextMessage(socket);
  expect(hello.type).toBe('hello_ack');
  return socket;
}

async function connectHost(url: string, relayRoomId: string, hostToken: string, hostSessionId = 'host_1'): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await waitForOpen(socket);
  socket.send(JSON.stringify({ type: 'hello', asHost: true, relayRoomId, hostSessionId, hostToken }));
  const hello = await nextMessage(socket);
  expect(hello).toMatchObject({ type: 'hello_ack', role: 'host', hostOnline: true });
  return socket;
}

describe('relay websocket authority bridge', () => {
  it('rejects edit proposals when host authority is unavailable', async () => {
    const stack = await startRelayStack();
    const room = await stack.service.createRoom();
    const grant = await stack.service.createAccessGrant({ relayRoomId: room.relayRoomId, role: 'edit' });
    const editor = await connectParticipant(stack.url, {
      relayRoomId: room.relayRoomId,
      token: grant.token,
      clientId: 'editor',
    });
    editor.send(JSON.stringify({ type: 'propose_update', proposalId: 'p1', updateBase64: 'AQID' }));
    await expect(nextMessage(editor)).resolves.toMatchObject({ type: 'rejected', reason: 'host_offline' });
    await expect(stack.service.getRoom(room.relayRoomId)).resolves.toMatchObject({ sharedRevision: 0 });
  });

  it('keeps view clients unable to write even while the host is online', async () => {
    const stack = await startRelayStack();
    const room = await stack.service.createRoom({ hostAuthToken: 'host-secret' });
    const grant = await stack.service.createAccessGrant({ relayRoomId: room.relayRoomId, role: 'view' });
    await connectHost(stack.url, room.relayRoomId, 'host-secret');
    const viewer = await connectParticipant(stack.url, {
      relayRoomId: room.relayRoomId,
      token: grant.token,
      clientId: 'viewer',
    });

    viewer.send(JSON.stringify({ type: 'propose_update', proposalId: 'view-write', updateBase64: 'AQID' }));

    await expect(nextMessage(viewer, 'view write rejection')).resolves.toMatchObject({
      type: 'rejected',
      reason: 'forbidden',
    });
    await expect(stack.service.getRoom(room.relayRoomId)).resolves.toMatchObject({ sharedRevision: 0 });
  });

  it('rejects writes after the host lease expires before accepting a proposal', async () => {
    const stack = await startRelayStack({ hostLeaseMs: 100 });
    const room = await stack.service.createRoom({ hostAuthToken: 'host-secret' });
    const grant = await stack.service.createAccessGrant({ relayRoomId: room.relayRoomId, role: 'edit' });
    await connectHost(stack.url, room.relayRoomId, 'host-secret');
    const editor = await connectParticipant(stack.url, {
      relayRoomId: room.relayRoomId,
      token: grant.token,
      clientId: 'editor',
    });

    await new Promise((resolve) => setTimeout(resolve, 150));
    editor.send(JSON.stringify({ type: 'propose_update', proposalId: 'expired-host', updateBase64: 'AQID' }));

    await expect(nextMessage(editor, 'host lease rejection')).resolves.toMatchObject({
      type: 'rejected',
      reason: 'host_lease_expired',
    });
    await expect(stack.service.getRoom(room.relayRoomId)).resolves.toMatchObject({ sharedRevision: 0 });
  });

  it('rejects websocket messages over the configured byte limit', async () => {
    const stack = await startRelayStack({ maxMessageBytes: 96 });
    const socket = new WebSocket(stack.url);
    await waitForOpen(socket);

    const closed = once(socket, 'close');
    socket.send(JSON.stringify({ type: 'hello', relayRoomId: 'room-too-large', token: 'x'.repeat(120) }));

    const [code] = await closed;
    expect(code).toBe(1009);
  });

  it('enforces a per-room connection limit', async () => {
    const stack = await startRelayStack({ maxConnectionsPerRoom: 2 });
    const room = await stack.service.createRoom({ hostAuthToken: 'host-secret' });
    const grantA = await stack.service.createAccessGrant({ relayRoomId: room.relayRoomId, role: 'edit' });
    const grantB = await stack.service.createAccessGrant({ relayRoomId: room.relayRoomId, role: 'edit' });
    await connectHost(stack.url, room.relayRoomId, 'host-secret');
    await connectParticipant(stack.url, {
      relayRoomId: room.relayRoomId,
      token: grantA.token,
      clientId: 'alice',
    });

    const bob = new WebSocket(stack.url);
    await waitForOpen(bob);
    bob.send(
      JSON.stringify({
        type: 'hello',
        relayRoomId: room.relayRoomId,
        token: grantB.token,
        clientId: 'bob',
        clientKind: 'browser',
      }),
    );

    await expect(nextMessage(bob, 'connection limit')).resolves.toMatchObject({
      type: 'error',
      error: 'room_connection_limit_exceeded',
    });
    expect(stack.relay.connectionCount).toBe(2);
  });

  it('forwards ephemeral awareness updates to other live room sockets without echoing to the sender', async () => {
    const stack = await startRelayStack();
    const room = await stack.service.createRoom();
    const aliceGrant = await stack.service.createAccessGrant({ relayRoomId: room.relayRoomId, role: 'edit' });
    const bobGrant = await stack.service.createAccessGrant({ relayRoomId: room.relayRoomId, role: 'edit' });
    const alice = await connectParticipant(stack.url, {
      relayRoomId: room.relayRoomId,
      token: aliceGrant.token,
      clientId: 'alice',
      displayName: 'Alice',
    });
    const bob = await connectParticipant(stack.url, {
      relayRoomId: room.relayRoomId,
      token: bobGrant.token,
      clientId: 'bob',
      displayName: 'Bob',
    });

    alice.send(JSON.stringify({ type: 'awareness_update', updateBase64: 'AQID' }));

    await expect(nextMessageOfType(bob, 'awareness_update')).resolves.toMatchObject({
      type: 'awareness_update',
      updateBase64: 'AQID',
    });
    await expectNoMessage(alice, 'awareness_echo');
    await expect(stack.service.getRoom(room.relayRoomId)).resolves.toMatchObject({ sharedRevision: 0 });
  });

  it('rejects websocket clients that claim host authority without the host token', async () => {
    const stack = await startRelayStack();
    const room = await stack.service.createRoom({ hostAuthToken: 'host-secret' });
    const host = await connectHost(stack.url, room.relayRoomId, 'host-secret');
    const attacker = new WebSocket(stack.url);
    await waitForOpen(attacker);

    attacker.send(
      JSON.stringify({
        type: 'hello',
        asHost: true,
        relayRoomId: room.relayRoomId,
        hostSessionId: 'host_attacker',
        hostToken: 'wrong-secret',
      }),
    );

    await expect(nextMessage(attacker, 'host_rejection')).resolves.toMatchObject({ type: 'error', error: 'forbidden' });
    expect(host.readyState).toBe(WebSocket.OPEN);
    expect(stack.relay.connectionCount).toBe(1);
    await expect(stack.service.getRoom(room.relayRoomId)).resolves.toMatchObject({ state: 'host_online' });
  });

  it('advances shared revision only after the host acknowledges the proposal', async () => {
    const stack = await startRelayStack();
    const room = await stack.service.createRoom({ hostAuthToken: 'host-secret' });
    const grant = await stack.service.createAccessGrant({ relayRoomId: room.relayRoomId, role: 'edit' });
    const host = await connectHost(stack.url, room.relayRoomId, 'host-secret');
    const editor = await connectParticipant(stack.url, {
      relayRoomId: room.relayRoomId,
      token: grant.token,
      clientId: 'editor',
    });
    expect(stack.relay.connectionCount).toBe(2);
    await expect(stack.service.getRoom(room.relayRoomId)).resolves.toMatchObject({ state: 'host_online' });

    const proposal = nextMessageOfType(host, 'proposal');
    editor.send(
      JSON.stringify({
        type: 'propose_update',
        proposalId: 'p2',
        updateBase64: Buffer.from(createState('accepted')).toString('base64'),
      }),
    );
    await expect(proposal).resolves.toMatchObject({ type: 'proposal', proposalId: 'p2' });
    await expect(stack.service.getRoom(room.relayRoomId)).resolves.toMatchObject({ sharedRevision: 0 });

    const accepted = nextMessage(editor);
    host.send(
      JSON.stringify({
        type: 'host_ack',
        proposalId: 'p2',
        yjsStateBase64: Buffer.from(createState('accepted')).toString('base64'),
        sharedHash: sha256Hex('accepted'),
      }),
    );
    await expect(accepted).resolves.toMatchObject({
      type: 'accepted_update',
      proposalId: 'p2',
      sharedRevision: 1,
      sharedHash: sha256Hex('accepted'),
    });
    await expect(stack.service.getRoom(room.relayRoomId)).resolves.toMatchObject({
      sharedRevision: 1,
      lastSharedHash: sha256Hex('accepted'),
    });
  });

  it('forwards replace proposals and marks the accepted broadcast as replacement state', async () => {
    const stack = await startRelayStack();
    const room = await stack.service.createRoom({ hostAuthToken: 'host-secret' });
    const grant = await stack.service.createAccessGrant({ relayRoomId: room.relayRoomId, role: 'edit' });
    const host = await connectHost(stack.url, room.relayRoomId, 'host-secret');
    const editor = await connectParticipant(stack.url, {
      relayRoomId: room.relayRoomId,
      token: grant.token,
      clientId: 'editor',
    });

    const proposal = nextMessageOfType(host, 'proposal');
    editor.send(
      JSON.stringify({
        type: 'propose_update',
        proposalId: 'replace-resolution',
        updateBase64: Buffer.from(createState('resolved')).toString('base64'),
        replace: true,
      }),
    );
    await expect(proposal).resolves.toMatchObject({
      type: 'proposal',
      proposalId: 'replace-resolution',
      replace: true,
    });

    const accepted = nextMessage(editor);
    host.send(
      JSON.stringify({
        type: 'host_ack',
        proposalId: 'replace-resolution',
        yjsStateBase64: Buffer.from(createState('resolved')).toString('base64'),
        sharedHash: sha256Hex('resolved'),
      }),
    );
    await expect(accepted).resolves.toMatchObject({
      type: 'accepted_update',
      proposalId: 'replace-resolution',
      replace: true,
      sharedRevision: 1,
      sharedHash: sha256Hex('resolved'),
    });
  });

  it('does not advance shared revision or broadcast accepted updates when host write fails', async () => {
    const stack = await startRelayStack();
    const room = await stack.service.createRoom({ hostAuthToken: 'host-secret' });
    const grant = await stack.service.createAccessGrant({ relayRoomId: room.relayRoomId, role: 'edit' });
    const host = await connectHost(stack.url, room.relayRoomId, 'host-secret');
    const editor = await connectParticipant(stack.url, {
      relayRoomId: room.relayRoomId,
      token: grant.token,
      clientId: 'editor',
    });

    const proposal = nextMessageOfType(host, 'proposal');
    editor.send(JSON.stringify({ type: 'propose_update', proposalId: 'p3', updateBase64: 'AQID' }));
    await proposal;
    const rejected = nextMessage(editor);
    host.send(JSON.stringify({ type: 'host_reject', proposalId: 'p3', reason: 'host_write_failed' }));
    await expect(rejected).resolves.toMatchObject({ type: 'rejected', reason: 'host_write_failed' });
    await expect(stack.service.getRoom(room.relayRoomId)).resolves.toMatchObject({
      sharedRevision: 0,
      lastSharedHash: null,
    });
  });

  it('rejects host acknowledgements that do not match a pending proposal', async () => {
    const stack = await startRelayStack();
    const room = await stack.service.createRoom({ hostAuthToken: 'host-secret' });
    const host = await connectHost(stack.url, room.relayRoomId, 'host-secret');

    host.send(
      JSON.stringify({
        type: 'host_ack',
        proposalId: 'missing-proposal',
        yjsStateBase64: Buffer.from(createState('unmatched')).toString('base64'),
        sharedHash: sha256Hex('unmatched'),
      }),
    );

    await expect(nextMessageOfType(host, 'error', 'unknown proposal')).resolves.toMatchObject({
      type: 'error',
      error: 'unknown_proposal',
    });
    await expect(stack.service.getRoom(room.relayRoomId)).resolves.toMatchObject({
      sharedRevision: 0,
      lastSharedHash: null,
    });
  });

  it('rejects concurrent proposals while a host acknowledgement is still pending', async () => {
    const stack = await startRelayStack();
    const room = await stack.service.createRoom({ hostAuthToken: 'host-secret' });
    const editA = await stack.service.createAccessGrant({ relayRoomId: room.relayRoomId, role: 'edit' });
    const editB = await stack.service.createAccessGrant({ relayRoomId: room.relayRoomId, role: 'edit' });
    const host = await connectHost(stack.url, room.relayRoomId, 'host-secret');
    const alice = await connectParticipant(stack.url, {
      relayRoomId: room.relayRoomId,
      token: editA.token,
      clientId: 'alice',
    });
    const bob = await connectParticipant(stack.url, {
      relayRoomId: room.relayRoomId,
      token: editB.token,
      clientId: 'bob',
    });

    alice.send(JSON.stringify({ type: 'propose_update', proposalId: 'first', updateBase64: 'AQID' }));
    await expect(nextMessageOfType(host, 'proposal')).resolves.toMatchObject({ proposalId: 'first' });

    bob.send(JSON.stringify({ type: 'propose_update', proposalId: 'second', updateBase64: 'BAUG' }));
    await expect(nextMessage(bob, 'proposal in flight')).resolves.toMatchObject({
      type: 'rejected',
      proposalId: 'second',
      reason: 'proposal_in_flight',
    });
    await expect(stack.service.getRoom(room.relayRoomId)).resolves.toMatchObject({ sharedRevision: 0 });
  });

  it('disconnects only sessions attached to a revoked grant', async () => {
    const stack = await startRelayStack();
    const room = await stack.service.createRoom({ hostAuthToken: 'host-secret' });
    const editA = await stack.service.createAccessGrant({ relayRoomId: room.relayRoomId, role: 'edit' });
    const editB = await stack.service.createAccessGrant({ relayRoomId: room.relayRoomId, role: 'edit' });
    const host = await connectHost(stack.url, room.relayRoomId, 'host-secret');
    const alice = await connectParticipant(stack.url, {
      relayRoomId: room.relayRoomId,
      token: editA.token,
      clientId: 'alice',
    });
    const bob = await connectParticipant(stack.url, {
      relayRoomId: room.relayRoomId,
      token: editB.token,
      clientId: 'bob',
    });

    const aliceClosed = once(alice, 'close');
    stack.relay.disconnectGrant(editA.grantId);
    await aliceClosed;

    expect(host.readyState).toBe(WebSocket.OPEN);
    expect(bob.readyState).toBe(WebSocket.OPEN);
  });

  it('stop sharing ends relay access without deleting the hosted local file', async () => {
    const stack = await startRelayStack();
    const hostLocal = await createTempLocalService('# Shared\n\nStill local.\n');
    const hostController = createLocalRelayHostController({
      localFileService: hostLocal.service,
      relayService: stack.service,
      relayWebSocketUrl: stack.url,
      publicWebUrl: 'http://127.0.0.1:5175',
      pollIntervalMs: 50,
    });
    localControllers.push(hostController);
    const editLink = await hostController.createLink('edit');
    const editor = await connectParticipant(stack.url, {
      relayRoomId: editLink.relayRoomId,
      token: editLink.token,
      clientId: 'editor',
    });

    const closed = once(editor, 'close');
    stack.relay.closeRoom(editLink.relayRoomId);
    await closed;

    await expect(readFile(hostLocal.file, 'utf8')).resolves.toContain('Still local.');
  });

  it('writes browser-like relay proposals through the host local Markdown file before broadcasting acceptance', async () => {
    const stack = await startRelayStack();
    const hostLocal = await createTempLocalService('');
    const hostController = createLocalRelayHostController({
      localFileService: hostLocal.service,
      relayService: stack.service,
      relayWebSocketUrl: stack.url,
      publicWebUrl: 'http://127.0.0.1:5175',
      pollIntervalMs: 50,
    });
    localControllers.push(hostController);
    const editLink = await hostController.createLink('edit');
    const editor = await connectParticipant(stack.url, {
      relayRoomId: editLink.relayRoomId,
      token: editLink.token,
      clientId: 'browser_writer',
    });

    const proposedState = await localServiceState('# Browser write\n\nAccepted through host.\n');
    editor.send(
      JSON.stringify({
        type: 'propose_update',
        proposalId: 'browser-local-file-write',
        updateBase64: Buffer.from(proposedState).toString('base64'),
      }),
    );

    await expect(nextMessage(editor, 'accepted browser write')).resolves.toMatchObject({
      type: 'accepted_update',
      proposalId: 'browser-local-file-write',
      sharedRevision: 1,
    });
    await waitForCondition(async () => {
      await expect(readFile(hostLocal.file, 'utf8')).resolves.toContain('Accepted through host.');
    });
  });

  it('rejects browser relay proposals with host_file_missing before pausing a host with no backing file', async () => {
    const stack = await startRelayStack({ proposalTimeoutMs: 2000 });
    const hostLocal = await createTempLocalService('# Local before missing file\n');
    const hostController = createLocalRelayHostController({
      localFileService: hostLocal.service,
      relayService: stack.service,
      relayWebSocketUrl: stack.url,
      publicWebUrl: 'http://127.0.0.1:5175',
      pollIntervalMs: 10_000,
    });
    localControllers.push(hostController);
    const editLink = await hostController.createLink('edit');
    await rm(hostLocal.file, { force: true });
    const editor = await connectParticipant(stack.url, {
      relayRoomId: editLink.relayRoomId,
      token: editLink.token,
      clientId: 'browser_missing_host_file',
    });

    const proposedState = await localServiceState('# Browser write while host file is missing\n');
    editor.send(
      JSON.stringify({
        type: 'propose_update',
        proposalId: 'browser-write-missing-host-file',
        updateBase64: Buffer.from(proposedState).toString('base64'),
      }),
    );

    await expect(nextMessage(editor, 'missing host file rejection')).resolves.toMatchObject({
      type: 'rejected',
      proposalId: 'browser-write-missing-host-file',
      reason: 'host_file_missing',
    });
    await waitForCondition(async () => {
      await expect(stack.service.getRoom(editLink.relayRoomId)).resolves.toMatchObject({ state: 'host_offline' });
      expect(hostLocal.service.getSummary().conflict).toBe('host_file_missing');
    });
  });

  it('opens host-side proposal conflicts against the current relay revision after earlier accepted edits', async () => {
    const stack = await startRelayStack();
    const hostLocal = await createTempLocalService('# Base\n');
    const hostController = createLocalRelayHostController({
      localFileService: hostLocal.service,
      relayService: stack.service,
      relayWebSocketUrl: stack.url,
      publicWebUrl: 'http://127.0.0.1:5175',
      pollIntervalMs: 50,
    });
    localControllers.push(hostController);
    const editLink = await hostController.createLink('edit');
    const editor = await connectParticipant(stack.url, {
      relayRoomId: editLink.relayRoomId,
      token: editLink.token,
      clientId: 'browser_host_conflict',
    });

    const acceptedState = await localServiceState('# Browser accepted\n');
    editor.send(
      JSON.stringify({
        type: 'propose_update',
        proposalId: 'browser-accepted-before-conflict',
        updateBase64: Buffer.from(acceptedState).toString('base64'),
        replace: true,
      }),
    );

    await expect(nextMessage(editor, 'accepted browser write before conflict')).resolves.toMatchObject({
      type: 'accepted_update',
      proposalId: 'browser-accepted-before-conflict',
      sharedRevision: 1,
      sharedHash: sha256Hex('# Browser accepted\n'),
    });
    await writeFile(hostLocal.file, '# Local disk conflict\n', 'utf8');

    const proposedState = await localServiceState('# Browser proposed during conflict\n');
    editor.send(
      JSON.stringify({
        type: 'propose_update',
        proposalId: 'browser-conflicting-proposal',
        updateBase64: Buffer.from(proposedState).toString('base64'),
        replace: true,
      }),
    );

    await expect(nextMessage(editor, 'conflicting browser write rejection')).resolves.toMatchObject({
      type: 'rejected',
      proposalId: 'browser-conflicting-proposal',
      reason: 'host_write_failed',
    });
    await waitForCondition(() => {
      expect(hostLocal.service.getCurrentConflict()).toMatchObject({
        sharedRevision: 1,
        sharedHash: sha256Hex('# Browser proposed during conflict\n'),
        expectedSharedRevision: 1,
        expectedSharedHash: sha256Hex('# Browser accepted\n'),
      });
    });
    const conflict = hostLocal.service.getCurrentConflict();
    if (!conflict) throw new Error('missing_host_conflict');

    await expect(hostController.verifySharedState({
      expectedSharedRevision: conflict.expectedSharedRevision,
      expectedSharedHash: conflict.expectedSharedHash,
    })).resolves.toBeUndefined();
    const prepared = await hostLocal.service.prepareUseLocalConflict(
      conflict.conflictId,
      conflict.expectedSharedRevision,
      conflict.expectedSharedHash,
    );
    const publish = hostController.publishResolvedState({
      relayRoomId: editLink.relayRoomId,
      yjsState: prepared.yjsState,
      sharedHash: prepared.hash,
      expectedSharedRevision: conflict.expectedSharedRevision,
      expectedSharedHash: conflict.expectedSharedHash,
    });

    await expect(nextMessage(editor, 'accepted host conflict resolution')).resolves.toMatchObject({
      type: 'accepted_update',
      replace: true,
      sharedRevision: 2,
      sharedHash: sha256Hex('# Local disk conflict\n'),
    });
    await expect(publish).resolves.toMatchObject({
      sharedRevision: 2,
      sharedHash: sha256Hex('# Local disk conflict\n'),
    });
  });

  it('broadcasts host conflict-resolution replacements to connected relay clients', async () => {
    const stack = await startRelayStack();
    const hostLocal = await createTempLocalService('# Base\n');
    const hostController = createLocalRelayHostController({
      localFileService: hostLocal.service,
      relayService: stack.service,
      relayWebSocketUrl: stack.url,
      publicWebUrl: 'http://127.0.0.1:5175',
      pollIntervalMs: 50,
    });
    localControllers.push(hostController);
    const editLink = await hostController.createLink('edit');
    const editor = await connectParticipant(stack.url, {
      relayRoomId: editLink.relayRoomId,
      token: editLink.token,
      clientId: 'browser_conflict_resolution',
    });

    const resolvedState = await localServiceState('# Resolved by host\n');
    const publish = hostController.publishResolvedState({
      relayRoomId: editLink.relayRoomId,
      yjsState: resolvedState,
      sharedHash: sha256Hex('# Resolved by host\n'),
      expectedSharedRevision: 0,
      expectedSharedHash: hostLocal.service.getSummary().hash,
    });

    await expect(nextMessage(editor, 'host conflict resolution')).resolves.toMatchObject({
      type: 'accepted_update',
      replace: true,
      sharedRevision: 1,
      sharedHash: sha256Hex('# Resolved by host\n'),
    });
    await expect(publish).resolves.toMatchObject({
      sharedRevision: 1,
      sharedHash: sha256Hex('# Resolved by host\n'),
    });
  });

  it('rejects stale host conflict-resolution replacements without advancing relay state', async () => {
    const stack = await startRelayStack();
    const room = await stack.service.createRoom({ hostAuthToken: 'host-secret' });
    const grant = await stack.service.createAccessGrant({ relayRoomId: room.relayRoomId, role: 'edit' });
    const host = await connectHost(stack.url, room.relayRoomId, 'host-secret');
    const editor = await connectParticipant(stack.url, {
      relayRoomId: room.relayRoomId,
      token: grant.token,
      clientId: 'browser_stale_conflict_resolution',
    });
    await stack.service.acceptSharedState({
      relayRoomId: room.relayRoomId,
      yjsState: createState('intervening shared state'),
      sharedHash: sha256Hex('intervening shared state'),
      expectedRevision: 0,
    });

    host.send(
      JSON.stringify({
        type: 'host_update',
        yjsStateBase64: Buffer.from(createState('stale resolution')).toString('base64'),
        sharedHash: sha256Hex('stale resolution'),
        expectedSharedRevision: 0,
        replace: true,
      }),
    );

    await expect(nextMessageOfType(host, 'error', 'stale host conflict resolution rejection')).resolves.toMatchObject({
      type: 'error',
      error: 'relay_shared_state_not_accepted',
    });
    await expectNoMessage(editor, 'stale_host_conflict_resolution_broadcast');
    await expect(stack.service.getRoom(room.relayRoomId)).resolves.toMatchObject({
      sharedRevision: 1,
      lastSharedHash: sha256Hex('intervening shared state'),
    });
  });

  it('rejects mirror conflict resolution when the host acknowledges a different shared state', async () => {
    const stack = await startRelayStack();
    const baseState = createState('# Base\n');
    const room = await stack.service.createRoom({
      hostAuthToken: 'host-secret',
      lastEphemeralYjsState: baseState,
      lastSharedHash: sha256Hex('# Base\n'),
    });
    const grant = await stack.service.createAccessGrant({ relayRoomId: room.relayRoomId, role: 'edit' });
    const host = await connectHost(stack.url, room.relayRoomId, 'host-secret');
    const mirrorLocal = await createTempLocalService('# Local resolution\n');
    const mirror = createLocalRelayMirrorController({
      localFileService: mirrorLocal.service,
      relayRoomId: room.relayRoomId,
      token: grant.token,
      relayWebSocketUrl: stack.url,
      clientId: 'mirror_conflict_resolution',
      pollIntervalMs: 50,
    });
    const localResolutionState = createState('# Local resolution\n');
    const publish = mirror.publishResolvedState({
      yjsState: localResolutionState,
      sharedHash: sha256Hex('# Local resolution\n'),
      expectedSharedRevision: 0,
      expectedSharedHash: sha256Hex('# Base\n'),
    });

    const proposal = await nextMessageOfType(host, 'proposal', 'mirror conflict resolution proposal');
    expect(proposal).toMatchObject({ type: 'proposal', replace: true });
    host.send(
      JSON.stringify({
        type: 'host_ack',
        proposalId: proposal.proposalId,
        yjsStateBase64: Buffer.from(createState('# Different host state\n')).toString('base64'),
        sharedHash: sha256Hex('# Different host state\n'),
      }),
    );

    await expect(publish).rejects.toThrow('relay_shared_state_not_accepted');
  });

  it('rejects mirror conflict resolution when shared state advances before host acknowledgement', async () => {
    const stack = await startRelayStack({ proposalTimeoutMs: 2000 });
    const baseState = createState('# Base\n');
    const room = await stack.service.createRoom({
      hostAuthToken: 'host-secret',
      lastEphemeralYjsState: baseState,
      lastSharedHash: sha256Hex('# Base\n'),
    });
    const grant = await stack.service.createAccessGrant({ relayRoomId: room.relayRoomId, role: 'edit' });
    const host = await connectHost(stack.url, room.relayRoomId, 'host-secret');
    const mirrorLocal = await createTempLocalService('# Local stale resolution\n');
    const mirror = createLocalRelayMirrorController({
      localFileService: mirrorLocal.service,
      relayRoomId: room.relayRoomId,
      token: grant.token,
      relayWebSocketUrl: stack.url,
      clientId: 'mirror_stale_resolution',
      pollIntervalMs: 50,
    });
    const publish = mirror.publishResolvedState({
      yjsState: createState('# Local stale resolution\n'),
      sharedHash: sha256Hex('# Local stale resolution\n'),
      expectedSharedRevision: 0,
      expectedSharedHash: sha256Hex('# Base\n'),
    });

    const proposal = await nextMessageOfType(host, 'proposal', 'stale mirror resolution proposal');
    expect(proposal).toMatchObject({
      type: 'proposal',
      replace: true,
      expectedSharedRevision: 0,
      expectedSharedHash: sha256Hex('# Base\n'),
    });
    await stack.service.acceptSharedState({
      relayRoomId: room.relayRoomId,
      yjsState: createState('# Intervening shared edit\n'),
      sharedHash: sha256Hex('# Intervening shared edit\n'),
      expectedRevision: 0,
      expectedSharedHash: sha256Hex('# Base\n'),
    });
    host.send(
      JSON.stringify({
        type: 'host_ack',
        proposalId: proposal.proposalId,
        yjsStateBase64: Buffer.from(createState('# Local stale resolution\n')).toString('base64'),
        sharedHash: sha256Hex('# Local stale resolution\n'),
      }),
    );

    await expect(publish).rejects.toThrow('relay_shared_state_not_accepted');
    await expect(stack.service.getRoom(room.relayRoomId)).resolves.toMatchObject({
      sharedRevision: 1,
      lastSharedHash: sha256Hex('# Intervening shared edit\n'),
    });
  });

  it('fails mirror shared-state verification with the relay denial when the grant is revoked', async () => {
    const stack = await startRelayStack();
    const room = await stack.service.createRoom({
      hostAuthToken: 'host-secret',
      hostSessionId: 'host_1',
      lastSharedHash: sha256Hex('# Base\n'),
    });
    const grant = await stack.service.createAccessGrant({ relayRoomId: room.relayRoomId, role: 'edit' });
    await stack.service.revokeAccessGrant(grant.grantId);
    const mirrorLocal = await createTempLocalService('# Base\n');
    const mirror = createLocalRelayMirrorController({
      localFileService: mirrorLocal.service,
      relayRoomId: room.relayRoomId,
      token: grant.token,
      relayWebSocketUrl: stack.url,
      clientId: 'revoked_verify_mirror',
      pollIntervalMs: 50,
    });

    await expect(mirror.verifySharedState({
      expectedSharedRevision: 0,
      expectedSharedHash: sha256Hex('# Base\n'),
    })).rejects.toThrow('forbidden');
  });

  it('fails mirror conflict publish with the relay denial when the grant is revoked', async () => {
    const stack = await startRelayStack();
    const room = await stack.service.createRoom({
      hostAuthToken: 'host-secret',
      hostSessionId: 'host_1',
      lastSharedHash: sha256Hex('# Base\n'),
    });
    const grant = await stack.service.createAccessGrant({ relayRoomId: room.relayRoomId, role: 'edit' });
    await stack.service.revokeAccessGrant(grant.grantId);
    const mirrorLocal = await createTempLocalService('# Local resolution\n');
    const mirror = createLocalRelayMirrorController({
      localFileService: mirrorLocal.service,
      relayRoomId: room.relayRoomId,
      token: grant.token,
      relayWebSocketUrl: stack.url,
      clientId: 'revoked_publish_mirror',
      pollIntervalMs: 50,
    });

    await expect(mirror.publishResolvedState({
      yjsState: createState('# Local resolution\n'),
      sharedHash: sha256Hex('# Local resolution\n'),
      expectedSharedRevision: 0,
      expectedSharedHash: sha256Hex('# Base\n'),
    })).rejects.toThrow('forbidden');
  });

  it('reconnects a restarted host daemon to the same relay room so existing edit links resume', async () => {
    const stack = await startRelayStack();
    const hostLocal = await createTempLocalService('# Shared\n\nInitial.\n');
    const hostController = createLocalRelayHostController({
      localFileService: hostLocal.service,
      relayService: stack.service,
      relayWebSocketUrl: stack.url,
      publicWebUrl: 'http://127.0.0.1:5175',
      pollIntervalMs: 50,
    });
    localControllers.push(hostController);
    const editLink = await hostController.createLink('edit');

    hostController.stop();
    hostLocal.service.stopWatcher();
    await waitForCondition(async () => {
      await expect(stack.service.getRoom(editLink.relayRoomId)).resolves.toMatchObject({ state: 'host_offline' });
    });

    const restartedService = await createLocalFileServiceWithOptions(hostLocal.file, {
      metadataPath: hostLocal.metadataPath,
    });
    restartedService.startWatcher({
      flushRoom: async () => undefined,
      applyRoomState: async () => undefined,
    });
    localServices.push(restartedService);
    const restartedHost = createLocalRelayHostController({
      localFileService: restartedService,
      relayService: stack.service,
      relayWebSocketUrl: stack.url,
      publicWebUrl: 'http://127.0.0.1:5175',
      pollIntervalMs: 50,
    });
    localControllers.push(restartedHost);

    await expect(restartedHost.resumeHosted()).resolves.toBe(true);
    expect(restartedHost.relayRoomId).toBe(editLink.relayRoomId);
    const editor = await connectParticipant(stack.url, {
      relayRoomId: editLink.relayRoomId,
      token: editLink.token,
      clientId: 'browser_after_restart',
    });
    const proposedState = await localServiceState('# Shared\n\nAccepted after restart.\n');
    editor.send(
      JSON.stringify({
        type: 'propose_update',
        proposalId: 'after-restart',
        updateBase64: Buffer.from(proposedState).toString('base64'),
      }),
    );

    await expect(nextMessage(editor, 'accepted after restart')).resolves.toMatchObject({
      type: 'accepted_update',
      proposalId: 'after-restart',
    });
    await waitForCondition(async () => {
      await expect(readFile(hostLocal.file, 'utf8')).resolves.toContain('Accepted after restart.');
    });
  });

  it('opens a host reconnect conflict instead of overwriting relay state advanced while stopped', async () => {
    const stack = await startRelayStack();
    const hostLocal = await createTempLocalService('# Shared\n\nInitial.\n');
    const hostController = createLocalRelayHostController({
      localFileService: hostLocal.service,
      relayService: stack.service,
      relayWebSocketUrl: stack.url,
      publicWebUrl: 'http://127.0.0.1:5175',
      pollIntervalMs: 50,
    });
    localControllers.push(hostController);
    const editLink = await hostController.createLink('edit');

    hostController.stop();
    await waitForCondition(async () => {
      await expect(stack.service.getRoom(editLink.relayRoomId)).resolves.toMatchObject({ state: 'host_offline' });
    });
    await writeFile(hostLocal.file, '# Shared\n\nHost local edit while stopped.\n', 'utf8');
    await stack.service.markHostOnline(editLink.relayRoomId, 'external_host');
    const remoteMarkdown = '# Shared\n\nRelay update while host stopped.\n';
    const remoteState = await localServiceState(remoteMarkdown);
    await stack.service.acceptSharedState({
      relayRoomId: editLink.relayRoomId,
      yjsState: remoteState,
      sharedHash: sha256Hex(remoteMarkdown),
      expectedRevision: 0,
      expectedSharedHash: sha256Hex('# Shared\n\nInitial.\n'),
    });
    await stack.service.markHostOffline(editLink.relayRoomId, 'external_host');

    const restartedService = await createLocalFileServiceWithOptions(hostLocal.file, {
      metadataPath: hostLocal.metadataPath,
    });
    restartedService.startWatcher({
      flushRoom: async () => undefined,
      applyRoomState: async () => undefined,
    });
    localServices.push(restartedService);
    const restartedHost = createLocalRelayHostController({
      localFileService: restartedService,
      relayService: stack.service,
      relayWebSocketUrl: stack.url,
      publicWebUrl: 'http://127.0.0.1:5175',
      pollIntervalMs: 50,
    });
    localControllers.push(restartedHost);

    await expect(restartedHost.resumeHosted()).resolves.toBe(true);
    await waitForCondition(() => {
      expect(restartedService.getCurrentConflict()).toMatchObject({
        relayRoomId: editLink.relayRoomId,
        localMarkdown: '# Shared\n\nHost local edit while stopped.\n',
        sharedMarkdown: remoteMarkdown,
        expectedSharedRevision: 1,
        expectedSharedHash: sha256Hex(remoteMarkdown),
        status: 'open',
      });
    });
    const conflict = restartedService.getCurrentConflict();
    if (!conflict) throw new Error('missing_restarted_host_conflict');
    const prepared = await restartedService.prepareUseLocalConflict(
      conflict.conflictId,
      conflict.expectedSharedRevision,
      conflict.expectedSharedHash,
    );
    await expect(restartedHost.publishResolvedState({
      relayRoomId: editLink.relayRoomId,
      yjsState: prepared.yjsState,
      sharedHash: prepared.hash,
      expectedSharedRevision: conflict.expectedSharedRevision,
      expectedSharedHash: conflict.expectedSharedHash,
    })).resolves.toMatchObject({
      sharedRevision: 2,
      sharedHash: sha256Hex('# Shared\n\nHost local edit while stopped.\n'),
    });
    await expect(stack.service.getRoom(editLink.relayRoomId)).resolves.toMatchObject({
      state: 'host_online',
      lastSharedHash: sha256Hex('# Shared\n\nHost local edit while stopped.\n'),
      sharedRevision: 2,
    });
  });

  it('keeps two daemon local files mirrored for online edits in both directions', async () => {
    const stack = await startRelayStack();
    const hostLocal = await createTempLocalService('# Shared\n\nInitial.\n');
    const hostController = createLocalRelayHostController({
      localFileService: hostLocal.service,
      relayService: stack.service,
      relayWebSocketUrl: stack.url,
      publicWebUrl: 'http://127.0.0.1:5175',
      pollIntervalMs: 50,
    });
    localControllers.push(hostController);
    const editLink = await hostController.createLink('edit');

    const bobLocal = await createTempLocalService('');
    const bobMirror = createLocalRelayMirrorController({
      localFileService: bobLocal.service,
      relayRoomId: editLink.relayRoomId,
      token: editLink.token,
      relayWebSocketUrl: stack.url,
      clientId: 'bob_daemon',
      displayName: 'Bob daemon',
      pollIntervalMs: 50,
    });
    localControllers.push(bobMirror);
    await bobMirror.start();

    await waitForCondition(async () => {
      await expect(readFile(bobLocal.file, 'utf8')).resolves.toContain('Initial.');
    });

    await writeFile(hostLocal.file, '# Shared\n\nHost online edit.\n', 'utf8');
    await waitForCondition(async () => {
      await expect(readFile(bobLocal.file, 'utf8')).resolves.toContain('Host online edit.');
    }, 6000);

    await writeFile(bobLocal.file, '# Shared\n\nBob online edit.\n', 'utf8');
    await waitForCondition(async () => {
      await expect(readFile(hostLocal.file, 'utf8')).resolves.toContain('Bob online edit.');
    }, 6000);
  });

  it('retries host local publishes when the relay rejects before accepting the update', async () => {
    const stack = await startRelayStack();
    const hostLocal = await createTempLocalService('# Shared\n\nInitial.\n');
    const hostController = createLocalRelayHostController({
      localFileService: hostLocal.service,
      relayService: stack.service,
      relayWebSocketUrl: stack.url,
      publicWebUrl: 'http://127.0.0.1:5175',
      pollIntervalMs: 50,
    });
    localControllers.push(hostController);
    const editLink = await hostController.createLink('edit');
    const targetMarkdown = '# Shared\n\nHost edit after transient rejection.\n';
    const targetHash = sha256Hex(targetMarkdown);
    const acceptSharedState = stack.service.acceptSharedState.bind(stack.service);
    let attempts = 0;
    stack.service.acceptSharedState = async (input) => {
      if (input.sharedHash === targetHash) {
        attempts += 1;
        if (attempts === 1) throw new Error('transient_relay_write_failed');
      }
      return acceptSharedState(input);
    };

    await writeFile(hostLocal.file, targetMarkdown, 'utf8');

    await waitForCondition(async () => {
      await expect(stack.service.getRoom(editLink.relayRoomId)).resolves.toMatchObject({
        lastSharedHash: targetHash,
      });
    }, 6000);
    expect(attempts).toBeGreaterThanOrEqual(2);
  });

  it('does not open a reconnect conflict when a mirror write is rejected for authorization', async () => {
    const stack = await startRelayStack();
    const hostLocal = await createTempLocalService('# Shared\n\nInitial.\n');
    const hostController = createLocalRelayHostController({
      localFileService: hostLocal.service,
      relayService: stack.service,
      relayWebSocketUrl: stack.url,
      publicWebUrl: 'http://127.0.0.1:5175',
      pollIntervalMs: 50,
    });
    localControllers.push(hostController);
    const viewLink = await hostController.createLink('view');

    const viewerLocal = await createTempLocalService('');
    const viewerMirror = createLocalRelayMirrorController({
      localFileService: viewerLocal.service,
      relayRoomId: viewLink.relayRoomId,
      token: viewLink.token,
      relayWebSocketUrl: stack.url,
      clientId: 'viewer_daemon',
      displayName: 'Viewer daemon',
      pollIntervalMs: 50,
    });
    localControllers.push(viewerMirror);
    await viewerMirror.start();
    await waitForCondition(async () => {
      await expect(readFile(viewerLocal.file, 'utf8')).resolves.toContain('Initial.');
    });
    const acceptedViewerHash = viewerLocal.service.getSummary().hash;

    await writeFile(viewerLocal.file, '# Shared\n\nViewer unauthorized local edit.\n', 'utf8');
    await waitForCondition(() => {
      expect(viewerLocal.service.getSummary().hash).not.toBe(acceptedViewerHash);
    });
    await waitForCondition(async () => {
      await expect(viewerMirror.shareState()).resolves.toMatchObject({ hostOnline: false });
    });

    expect(viewerLocal.service.getSummary().conflict).toBeNull();
    expect(viewerLocal.service.getCurrentConflict()).toBeNull();
    await expect(readFile(hostLocal.file, 'utf8')).resolves.not.toContain('Viewer unauthorized local edit.');
  });

  it('keeps mirror conflict packages on the latest shared state while collaborators continue editing', async () => {
    const stack = await startRelayStack();
    const hostLocal = await createTempLocalService('# Shared\n\nInitial.\n');
    const hostController = createLocalRelayHostController({
      localFileService: hostLocal.service,
      relayService: stack.service,
      relayWebSocketUrl: stack.url,
      publicWebUrl: 'http://127.0.0.1:5175',
      pollIntervalMs: 50,
    });
    localControllers.push(hostController);
    const editLink = await hostController.createLink('edit');

    const bobLocal = await createTempLocalService('');
    const bobMirror = createLocalRelayMirrorController({
      localFileService: bobLocal.service,
      relayRoomId: editLink.relayRoomId,
      token: editLink.token,
      relayWebSocketUrl: stack.url,
      clientId: 'bob_conflict_refresh',
      displayName: 'Bob conflict refresh',
      pollIntervalMs: 20000,
    });
    localControllers.push(bobMirror);
    await bobMirror.start();
    await waitForCondition(async () => {
      await expect(readFile(bobLocal.file, 'utf8')).resolves.toContain('Initial.');
    });
    bobLocal.service.stopWatcher();

    await writeFile(bobLocal.file, '# Shared\n\nBob local-only edit.\n', 'utf8');
    await expect(readFile(bobLocal.file, 'utf8')).resolves.toContain('Bob local-only edit.');
    await writeFile(hostLocal.file, '# Shared\n\nHost update one.\n', 'utf8');

    await waitForCondition(async () => {
      const room = await stack.service.getRoom(editLink.relayRoomId);
      const conflict = bobLocal.service.getCurrentConflict();
      expect(conflict).toMatchObject({
        relayRoomId: editLink.relayRoomId,
        sharedRevision: room.sharedRevision,
        sharedMarkdown: '# Shared\n\nHost update one.\n',
        status: 'open',
      });
    });

    await writeFile(hostLocal.file, '# Shared\n\nHost update two.\n', 'utf8');

    await waitForCondition(async () => {
      const room = await stack.service.getRoom(editLink.relayRoomId);
      const conflict = bobLocal.service.getCurrentConflict();
      expect(conflict).toMatchObject({
        relayRoomId: editLink.relayRoomId,
        sharedRevision: room.sharedRevision,
        sharedMarkdown: '# Shared\n\nHost update two.\n',
        status: 'open',
      });
    });
  });

  it('replays local mirror edits after host authority returns when shared state did not change', async () => {
    const stack = await startRelayStack();
    const hostLocal = await createTempLocalService('# Shared\n\nInitial.\n');
    const hostController = createLocalRelayHostController({
      localFileService: hostLocal.service,
      relayService: stack.service,
      relayWebSocketUrl: stack.url,
      publicWebUrl: 'http://127.0.0.1:5175',
      pollIntervalMs: 50,
    });
    localControllers.push(hostController);
    const editLink = await hostController.createLink('edit');

    const bobLocal = await createTempLocalService('');
    const bobMirror = createLocalRelayMirrorController({
      localFileService: bobLocal.service,
      relayRoomId: editLink.relayRoomId,
      token: editLink.token,
      relayWebSocketUrl: stack.url,
      clientId: 'bob_daemon',
      displayName: 'Bob daemon',
      pollIntervalMs: 50,
    });
    localControllers.push(bobMirror);
    await bobMirror.start();
    await waitForCondition(async () => {
      await expect(readFile(bobLocal.file, 'utf8')).resolves.toContain('Initial.');
    });

    hostController.stop();
    await waitForCondition(async () => {
      await expect(stack.service.getRoom(editLink.relayRoomId)).resolves.toMatchObject({ state: 'host_offline' });
    });
    const acceptedBobHash = bobLocal.service.getSummary().hash;
    await writeFile(bobLocal.file, '# Shared\n\nBob edit while host offline.\n', 'utf8');
    await waitForCondition(() => {
      expect(bobLocal.service.getSummary().hash).not.toBe(acceptedBobHash);
    });
    await expect(readFile(hostLocal.file, 'utf8')).resolves.not.toContain('Bob edit while host offline.');

    await hostController.start();
    await waitForCondition(() => {
      expect(bobLocal.service.getSummary().conflict).toBeNull();
    });
    await waitForCondition(async () => {
      await expect(readFile(hostLocal.file, 'utf8')).resolves.toContain('Bob edit while host offline.');
    });
    expect(bobLocal.service.getCurrentConflict()).toBeNull();
  });

  it('guards ordinary mirror local-change proposals and opens a conflict when host acknowledgement is stale', async () => {
    const stack = await startRelayStack({ proposalTimeoutMs: 2000 });
    const initialMarkdown = '# Shared\n\nInitial.\n';
    const initialHash = sha256Hex(initialMarkdown);
    const room = await stack.service.createRoom({
      hostAuthToken: 'host-secret',
      lastEphemeralYjsState: await localServiceState(initialMarkdown),
      lastSharedHash: initialHash,
    });
    const editLink = await stack.service.createAccessGrant({ relayRoomId: room.relayRoomId, role: 'edit' });
    const host = await connectHost(stack.url, room.relayRoomId, 'host-secret', 'manual_host');
    const bobLocal = await createTempLocalService('');
    const bobMirror = createLocalRelayMirrorController({
      localFileService: bobLocal.service,
      relayRoomId: editLink.relayRoomId,
      token: editLink.token,
      relayWebSocketUrl: stack.url,
      clientId: 'bob_guarded_ordinary_proposal',
      displayName: 'Bob guarded proposal',
      pollIntervalMs: 50,
    });
    localControllers.push(bobMirror);
    await bobMirror.start();
    await waitForCondition(async () => {
      await expect(readFile(bobLocal.file, 'utf8')).resolves.toContain('Initial.');
    });

    const bobMarkdown = '# Shared\n\nBob ordinary edit.\n';
    await writeFile(bobLocal.file, bobMarkdown, 'utf8');
    const proposal = await nextMessageOfType(host, 'proposal', 'ordinary mirror proposal');
    expect(proposal).toMatchObject({
      type: 'proposal',
      replace: false,
      expectedSharedRevision: 0,
      expectedSharedHash: initialHash,
    });

    const remoteMarkdown = '# Shared\n\nRemote wins first.\n';
    await stack.service.acceptSharedState({
      relayRoomId: room.relayRoomId,
      yjsState: await localServiceState(remoteMarkdown),
      sharedHash: sha256Hex(remoteMarkdown),
      expectedRevision: 0,
      expectedSharedHash: initialHash,
    });
    host.send(
      JSON.stringify({
        type: 'host_ack',
        proposalId: proposal.proposalId,
        yjsStateBase64: proposal.updateBase64,
        sharedHash: sha256Hex(bobMarkdown),
      }),
    );

    await waitForCondition(() => {
      expect(bobLocal.service.getCurrentConflict()).toMatchObject({
        relayRoomId: editLink.relayRoomId,
        localMarkdown: bobMarkdown,
        sharedMarkdown: remoteMarkdown,
        expectedSharedRevision: 1,
        expectedSharedHash: sha256Hex(remoteMarkdown),
        status: 'open',
      });
    });
    await expect(stack.service.getRoom(room.relayRoomId)).resolves.toMatchObject({
      sharedRevision: 1,
      lastSharedHash: sha256Hex(remoteMarkdown),
    });
  });

  it('opens a mirror reconnect conflict package when host returns after local and shared changed', async () => {
    const stack = await startRelayStack();
    const hostLocal = await createTempLocalService('# Shared\n\nInitial.\n');
    const hostController = createLocalRelayHostController({
      localFileService: hostLocal.service,
      relayService: stack.service,
      relayWebSocketUrl: stack.url,
      publicWebUrl: 'http://127.0.0.1:5175',
      pollIntervalMs: 50,
    });
    localControllers.push(hostController);
    const editLink = await hostController.createLink('edit');

    const bobLocal = await createTempLocalService('');
    const bobMirror = createLocalRelayMirrorController({
      localFileService: bobLocal.service,
      relayRoomId: editLink.relayRoomId,
      token: editLink.token,
      relayWebSocketUrl: stack.url,
      clientId: 'bob_daemon_conflict_package',
      displayName: 'Bob daemon',
      pollIntervalMs: 50,
    });
    localControllers.push(bobMirror);
    await bobMirror.start();
    await waitForCondition(async () => {
      await expect(readFile(bobLocal.file, 'utf8')).resolves.toContain('Initial.');
    });

    hostController.stop();
    await waitForCondition(async () => {
      await expect(stack.service.getRoom(editLink.relayRoomId)).resolves.toMatchObject({ state: 'host_offline' });
    });
    await writeFile(bobLocal.file, '# Shared\n\nBob edit while host offline.\n', 'utf8');
    await stack.service.markHostOnline(editLink.relayRoomId, 'external_host');
    const remoteMarkdown = '# Shared\n\nRelay changed too.\n';
    const remoteState = await localServiceState(remoteMarkdown);
    await stack.service.acceptSharedState({
      relayRoomId: editLink.relayRoomId,
      yjsState: remoteState,
      sharedHash: sha256Hex(remoteMarkdown),
      expectedRevision: 0,
      expectedSharedHash: sha256Hex('# Shared\n\nInitial.\n'),
    });
    await stack.service.markHostOffline(editLink.relayRoomId, 'external_host');

    await hostController.start();
    await waitForCondition(() => {
      expect(bobLocal.service.getCurrentConflict()).toMatchObject({
        relayRoomId: editLink.relayRoomId,
        localMarkdown: '# Shared\n\nBob edit while host offline.\n',
        sharedMarkdown: remoteMarkdown,
        expectedSharedRevision: 1,
        expectedSharedHash: sha256Hex(remoteMarkdown),
        status: 'open',
      });
    });
    await expect(readFile(hostLocal.file, 'utf8')).resolves.toContain('Relay changed too.');
  });

  it('opens a mirror reconnect conflict package after a host-lease rejection and later shared change', async () => {
    const stack = await startRelayStack({ hostLeaseMs: 100 });
    const initialMarkdown = '# Shared\n\nInitial.\n';
    const initialState = await localServiceState(initialMarkdown);
    const room = await stack.service.createRoom({
      hostAuthToken: 'host-secret',
      lastEphemeralYjsState: initialState,
      lastSharedHash: sha256Hex(initialMarkdown),
    });
    const editLink = await stack.service.createAccessGrant({ relayRoomId: room.relayRoomId, role: 'edit' });
    const staleHost = await connectHost(stack.url, room.relayRoomId, 'host-secret', 'stale_host');
    const bobLocal = await createTempLocalService('');
    const bobMirror = createLocalRelayMirrorController({
      localFileService: bobLocal.service,
      relayRoomId: editLink.relayRoomId,
      token: editLink.token,
      relayWebSocketUrl: stack.url,
      clientId: 'bob_lease_reject',
      displayName: 'Bob lease reject',
      pollIntervalMs: 50,
    });
    localControllers.push(bobMirror);
    await bobMirror.start();
    await waitForCondition(async () => {
      await expect(readFile(bobLocal.file, 'utf8')).resolves.toContain('Initial.');
    });

    await new Promise((resolve) => setTimeout(resolve, 150));
    await writeFile(bobLocal.file, '# Shared\n\nBob edit after stale lease.\n', 'utf8');
    await waitForCondition(async () => {
      await expect(bobMirror.shareState()).resolves.toMatchObject({ hostOnline: false });
    });
    expect(bobLocal.service.getCurrentConflict()).toBeNull();

    const remoteMarkdown = '# Shared\n\nRelay changed after lease rejection.\n';
    await stack.service.acceptSharedState({
      relayRoomId: editLink.relayRoomId,
      yjsState: await localServiceState(remoteMarkdown),
      sharedHash: sha256Hex(remoteMarkdown),
      expectedRevision: 0,
      expectedSharedHash: sha256Hex(initialMarkdown),
    });
    staleHost.close();
    await connectHost(stack.url, room.relayRoomId, 'host-secret', 'fresh_host');

    await waitForCondition(() => {
      expect(bobLocal.service.getCurrentConflict()).toMatchObject({
        relayRoomId: editLink.relayRoomId,
        localMarkdown: '# Shared\n\nBob edit after stale lease.\n',
        sharedMarkdown: remoteMarkdown,
        expectedSharedRevision: 1,
        expectedSharedHash: sha256Hex(remoteMarkdown),
        status: 'open',
      });
    });
  });

  it('pauses a reconnecting mirror instead of merging when local and shared states both changed offline', async () => {
    const stack = await startRelayStack();
    const hostLocal = await createTempLocalService('# Shared\n\nInitial.\n');
    const hostController = createLocalRelayHostController({
      localFileService: hostLocal.service,
      relayService: stack.service,
      relayWebSocketUrl: stack.url,
      publicWebUrl: 'http://127.0.0.1:5175',
      pollIntervalMs: 50,
    });
    localControllers.push(hostController);
    const editLink = await hostController.createLink('edit');

    const bobLocal = await createTempLocalService('');
    const firstMirror = createLocalRelayMirrorController({
      localFileService: bobLocal.service,
      relayRoomId: editLink.relayRoomId,
      token: editLink.token,
      relayWebSocketUrl: stack.url,
      clientId: 'bob_daemon',
      displayName: 'Bob daemon',
      pollIntervalMs: 50,
    });
    await firstMirror.start();
    await waitForCondition(async () => {
      await expect(readFile(bobLocal.file, 'utf8')).resolves.toContain('Initial.');
    });
    firstMirror.stop();
    bobLocal.service.stopWatcher();

    await writeFile(bobLocal.file, '# Shared\n\nBob offline edit.\n', 'utf8');
    await writeFile(hostLocal.file, '# Shared\n\nHost while Bob offline.\n', 'utf8');
    await waitForCondition(async () => {
      const state = await stack.service.listShareState(editLink.relayRoomId);
      expect(state.lastSharedHash).not.toBeNull();
      expect(state.sharedRevision).toBeGreaterThan(0);
    });

    const restartedBobService = await createLocalFileServiceWithOptions(bobLocal.file, {
      metadataPath: bobLocal.metadataPath,
    });
    localServices.push(restartedBobService);
    const reconnectingMirror = createLocalRelayMirrorController({
      localFileService: restartedBobService,
      relayRoomId: editLink.relayRoomId,
      token: editLink.token,
      relayWebSocketUrl: stack.url,
      clientId: 'bob_daemon',
      displayName: 'Bob daemon',
      pollIntervalMs: 50,
    });

    await reconnectingMirror.start().catch((error: unknown) => {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('relay_reconnect_conflict_plan3_required');
    });
    await waitForCondition(() => {
      expect(restartedBobService.getSummary().conflict).toBe('Relay reconnect conflict. Review needed before syncing resumes.');
    });
    expect(restartedBobService.getCurrentConflict()).toMatchObject({
      relayRoomId: editLink.relayRoomId,
      status: 'open',
    });
    await expect(readFile(bobLocal.file, 'utf8')).resolves.toContain('Bob offline edit.');
    await expect(readFile(bobLocal.file, 'utf8')).resolves.not.toContain('Host while Bob offline.');
  });
});
