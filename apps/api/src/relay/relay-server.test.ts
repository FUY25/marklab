import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createLocalFileServiceWithOptions, type LocalFileService } from '../local/local-file-service';
import { createLocalRelayHostController, createLocalRelayMirrorController, type LocalRelayHostController, type LocalRelayMirrorController } from '../local/local-relay-client';
import { createInMemoryRelayRoomService, type RelayRoomService } from './relay-room-service';
import { createRelayServer, type RelayServerHandle } from './relay-server';

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

async function startRelayStack(): Promise<RelayStack> {
  const service = createInMemoryRelayRoomService();
  const relay = createRelayServer(service, { proposalTimeoutMs: 500, hostLeaseMs: 5000 });
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
        sharedHash: 'sha256:accepted',
      }),
    );
    await expect(accepted).resolves.toMatchObject({
      type: 'accepted_update',
      proposalId: 'p2',
      sharedRevision: 1,
      sharedHash: 'sha256:accepted',
    });
    await expect(stack.service.getRoom(room.relayRoomId)).resolves.toMatchObject({
      sharedRevision: 1,
      lastSharedHash: 'sha256:accepted',
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
        sharedHash: 'sha256:resolved',
      }),
    );
    await expect(accepted).resolves.toMatchObject({
      type: 'accepted_update',
      proposalId: 'replace-resolution',
      replace: true,
      sharedRevision: 1,
      sharedHash: 'sha256:resolved',
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
        sharedHash: 'sha256:unmatched',
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
    });

    await writeFile(bobLocal.file, '# Shared\n\nBob online edit.\n', 'utf8');
    await waitForCondition(async () => {
      await expect(readFile(hostLocal.file, 'utf8')).resolves.toContain('Bob online edit.');
    });
  });

  it('does not replay local mirror edits made while host authority is offline', async () => {
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
      expect(bobLocal.service.getSummary().conflict).toBe('Relay reconnect conflict. Review needed before syncing resumes.');
    });
    await expect(readFile(hostLocal.file, 'utf8')).resolves.not.toContain('Bob edit while host offline.');
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

    await expect(reconnectingMirror.start()).rejects.toThrow('relay_reconnect_conflict_plan3_required');
    expect(restartedBobService.getSummary().conflict).toBe('Relay reconnect conflict. Review needed before syncing resumes.');
    await expect(readFile(bobLocal.file, 'utf8')).resolves.toContain('Bob offline edit.');
    await expect(readFile(bobLocal.file, 'utf8')).resolves.not.toContain('Host while Bob offline.');
  });
});
