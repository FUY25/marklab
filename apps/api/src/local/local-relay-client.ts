import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import WebSocket from 'ws';
import type { LocalFileService } from './local-file-service';
import { encodeYjsStateFingerprint } from '../services/yjs-state-fingerprint';
import type {
  CreatedRelayAccessGrant,
  RelayAccessRole,
  RelayRoomService,
  RelayShareState,
} from '../relay/relay-room-service';

export interface LocalRelayJoinState {
  relayRoomId: string;
  grantId: string;
  sessionId: string;
  relayRole?: RelayAccessRole;
  localDocId: string;
  absolutePath: string;
  lastAcceptedLocalHash: string;
  lastAcceptedSharedHash: string;
  lastAcceptedSharedRevision: number;
  lastAcceptedYjsStateBase64?: string | null;
  lastAcceptedStateFingerprint?: string | null;
  lastHostSessionId: string | null;
  disconnectedCleanly: boolean;
  updatedAt: string;
}

export interface LocalRelayHostController {
  readonly relayRoomId: string | null;
  ensureHosted(): Promise<{ relayRoomId: string; hostSessionId: string }>;
  start(): Promise<void>;
  stop(): void;
  createLink(role: RelayAccessRole): Promise<CreatedRelayAccessGrant & { url: string }>;
  shareState(): Promise<RelayShareState>;
  revokeLink(grantId: string): Promise<void>;
}

export interface LocalRelayMirrorController {
  start(): Promise<void>;
  stop(): void;
  shareState(): Promise<RelayShareState>;
  verifySharedState(input: { expectedSharedRevision: number; expectedSharedHash: string }): Promise<void>;
  publishResolvedState(input: {
    yjsState: Uint8Array;
    expectedSharedRevision: number;
    expectedSharedHash: string;
  }): Promise<{ sharedRevision: number; sharedHash: string | null; hostSessionId: string | null }>;
}

export interface CreateLocalRelayHostControllerOptions {
  localFileService: LocalFileService;
  relayService: RelayRoomService;
  relayWebSocketUrl: string;
  publicWebUrl: string;
  publicApiUrl?: string;
  publicRelayWebSocketUrl?: string;
  pollIntervalMs?: number;
}

export interface CreateLocalRelayMirrorControllerOptions {
  localFileService: LocalFileService;
  relayRoomId: string;
  token: string;
  relayWebSocketUrl: string;
  clientId: string;
  displayName?: string;
  pollIntervalMs?: number;
}

function encodeBase64(value: Uint8Array): string {
  return Buffer.from(value).toString('base64');
}

function decodeBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64'));
}

function buildRelayUrl(input: {
  publicWebUrl: string;
  relayRoomId: string;
  token: string;
  role: RelayAccessRole;
  publicApiUrl?: string;
  publicRelayWebSocketUrl?: string;
}): string {
  const url = new URL(`/relay/${encodeURIComponent(input.relayRoomId)}`, input.publicWebUrl);
  url.searchParams.set('token', input.token);
  url.searchParams.set('mode', input.role);
  if (input.publicApiUrl) url.searchParams.set('apiUrl', input.publicApiUrl);
  if (input.publicRelayWebSocketUrl) url.searchParams.set('wsUrl', input.publicRelayWebSocketUrl);
  return url.toString();
}

function relaySharedHash(value: string | null | undefined): string {
  return value ?? '';
}

async function currentLocalYjsState(localFileService: LocalFileService): Promise<Uint8Array> {
  const loaded = await localFileService.loadRoomState(localFileService.roomName);
  if (!loaded) throw new Error('local_room_not_found');
  return loaded.yjsState;
}

async function applyRelayUpdateToLocalFile(localFileService: LocalFileService, update: Uint8Array): Promise<Uint8Array> {
  const loaded = await localFileService.loadRoomState(localFileService.roomName);
  if (!loaded) throw new Error('local_room_not_found');
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, loaded.yjsState);
    Y.applyUpdate(doc, update);
    const nextState = Y.encodeStateAsUpdate(doc);
    await localFileService.storeRoomState(localFileService.roomName, nextState, loaded.stateFingerprint);
    return currentLocalYjsState(localFileService);
  } finally {
    doc.destroy();
  }
}

async function replaceLocalFileWithRelayState(localFileService: LocalFileService, yjsState: Uint8Array): Promise<Uint8Array> {
  const loaded = await localFileService.loadRoomState(localFileService.roomName);
  if (!loaded) throw new Error('local_room_not_found');
  await localFileService.storeRoomState(localFileService.roomName, yjsState, loaded.stateFingerprint);
  return currentLocalYjsState(localFileService);
}

function isBackingFileAvailable(localFileService: LocalFileService): boolean {
  return localFileService.isBackingFileAvailable?.() ?? true;
}

async function pauseForMissingBackingFile(localFileService: LocalFileService, kind: 'host' | 'mirror'): Promise<void> {
  if (localFileService.pauseForMissingBackingFile) {
    await localFileService.pauseForMissingBackingFile(kind);
    return;
  }
  await localFileService.pauseForRelayConflict(kind === 'host' ? 'host_file_missing' : 'mirror_file_missing');
}

class DefaultLocalRelayHostController implements LocalRelayHostController {
  private socket: WebSocket | null = null;
  private timer: NodeJS.Timeout | null = null;
  private currentRelayRoomId: string | null = null;
  private currentHostSessionId: string | null = null;
  private currentHostToken: string | null = null;
  private lastPublishedHash: string | null = null;
  private handlingProposal = false;
  private messageChain: Promise<void> = Promise.resolve();

  constructor(private readonly options: CreateLocalRelayHostControllerOptions) {}

  get relayRoomId(): string | null {
    return this.currentRelayRoomId;
  }

  async ensureHosted(): Promise<{ relayRoomId: string; hostSessionId: string }> {
    if (this.currentRelayRoomId && this.currentHostSessionId) {
      return { relayRoomId: this.currentRelayRoomId, hostSessionId: this.currentHostSessionId };
    }

    const hostSessionId = `host_${randomUUID()}`;
    const hostToken = `ml_relay_host_${randomUUID()}`;
    const yjsState = await currentLocalYjsState(this.options.localFileService);
    const summary = this.options.localFileService.getSummary();
    const room = await this.options.relayService.createRoom({
      hostSessionId,
      hostAuthToken: hostToken,
      lastEphemeralYjsState: yjsState,
      lastSharedHash: summary.hash,
    });
    this.currentRelayRoomId = room.relayRoomId;
    this.currentHostSessionId = hostSessionId;
    this.currentHostToken = hostToken;
    this.lastPublishedHash = summary.hash;
    await this.start();
    return { relayRoomId: room.relayRoomId, hostSessionId };
  }

  async start(): Promise<void> {
    const relayRoomId = this.currentRelayRoomId;
    const hostSessionId = this.currentHostSessionId;
    const hostToken = this.currentHostToken;
    if (!relayRoomId || !hostSessionId || !hostToken || this.socket) return;

    const socket = new WebSocket(this.options.relayWebSocketUrl);
    this.socket = socket;
    socket.on('open', () => {
      socket.send(
        JSON.stringify({
          type: 'hello',
          asHost: true,
          relayRoomId,
          hostSessionId,
          hostToken,
        }),
      );
      this.startPublishingLocalChanges();
    });
    socket.on('message', (raw) => {
      this.messageChain = this.messageChain
        .then(() => this.handleMessage(raw.toString()))
        .catch((error) => {
          socket.send(JSON.stringify({ type: 'host_reject', reason: error instanceof Error ? error.message : 'host_write_failed' }));
        });
      void this.messageChain;
    });
    socket.on('close', () => {
      this.stopPublishingLocalChanges();
      if (this.socket === socket) this.socket = null;
    });
    socket.on('error', () => undefined);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('relay_host_connect_timeout')), 3000);
      const cleanup = () => {
        clearTimeout(timeout);
        socket.off('message', handleReadyMessage);
        socket.off('error', handleReadyError);
      };
      const handleReadyError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const handleReadyMessage = (raw: WebSocket.RawData) => {
        try {
          const message = JSON.parse(raw.toString()) as { type?: string };
          if (message.type !== 'hello_ack') return;
          cleanup();
          resolve();
        } catch {
          // Keep waiting for the relay hello acknowledgement.
        }
      };
      socket.on('message', handleReadyMessage);
      socket.on('error', handleReadyError);
    });
  }

  private startPublishingLocalChanges(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.publishLocalChangeIfNeeded().catch(() => undefined);
    }, this.options.pollIntervalMs ?? 750);
    this.timer.unref();
  }

  private stopPublishingLocalChanges(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async publishLocalChangeIfNeeded(): Promise<void> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    if (this.handlingProposal) return;
    if (!isBackingFileAvailable(this.options.localFileService)) {
      await this.pauseHostForMissingBackingFile();
      return;
    }
    const summary = this.options.localFileService.getSummary();
    if (summary.conflict) return;
    if (summary.hash === this.lastPublishedHash) {
      this.socket.send(JSON.stringify({ type: 'ping' }));
      return;
    }
    const yjsState = await currentLocalYjsState(this.options.localFileService);
    this.socket.send(
      JSON.stringify({
        type: 'host_update',
        yjsStateBase64: encodeBase64(yjsState),
        sharedHash: summary.hash,
      }),
    );
    this.lastPublishedHash = summary.hash;
  }

  private async handleMessage(raw: string): Promise<void> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    const message = JSON.parse(raw) as {
      type: string;
      proposalId?: string;
      updateBase64?: string;
      sharedHash?: string;
      replace?: boolean;
    };
    if (message.type !== 'proposal' || !message.proposalId || !message.updateBase64) return;

    try {
      if (!isBackingFileAvailable(this.options.localFileService)) {
        await this.pauseHostForMissingBackingFile();
        this.socket.send(
          JSON.stringify({
            type: 'host_reject',
            proposalId: message.proposalId,
            reason: 'host_file_missing',
          }),
        );
        return;
      }
      this.handlingProposal = true;
      const acceptedState = message.replace
        ? await replaceLocalFileWithRelayState(this.options.localFileService, decodeBase64(message.updateBase64))
        : await applyRelayUpdateToLocalFile(this.options.localFileService, decodeBase64(message.updateBase64));
      const summary = this.options.localFileService.getSummary();
      this.lastPublishedHash = summary.hash;
      this.socket.send(
        JSON.stringify({
          type: 'host_ack',
          proposalId: message.proposalId,
          yjsStateBase64: encodeBase64(acceptedState),
          sharedHash: summary.hash,
        }),
      );
    } catch {
      this.socket.send(
        JSON.stringify({
          type: 'host_reject',
          proposalId: message.proposalId,
          reason: 'host_write_failed',
        }),
      );
    } finally {
      this.handlingProposal = false;
    }
  }

  private async pauseHostForMissingBackingFile(): Promise<void> {
    const relayRoomId = this.currentRelayRoomId;
    await pauseForMissingBackingFile(this.options.localFileService, 'host');
    if (relayRoomId) {
      await this.options.relayService.markHostOffline(relayRoomId, this.currentHostSessionId);
    }
    this.socket?.close(4008, 'host_file_missing');
    this.socket = null;
    this.stopPublishingLocalChanges();
  }

  stop(): void {
    this.stopPublishingLocalChanges();
    this.socket?.close(1001, 'host_stopped');
    this.socket = null;
  }

  async createLink(role: RelayAccessRole): Promise<CreatedRelayAccessGrant & { url: string }> {
    const { relayRoomId } = await this.ensureHosted();
    const grant = await this.options.relayService.createAccessGrant({ relayRoomId, role });
    const urlInput: Parameters<typeof buildRelayUrl>[0] = {
      publicWebUrl: this.options.publicWebUrl,
      relayRoomId: grant.relayRoomId,
      token: grant.token,
      role: grant.role,
    };
    if (this.options.publicApiUrl) urlInput.publicApiUrl = this.options.publicApiUrl;
    if (this.options.publicRelayWebSocketUrl) urlInput.publicRelayWebSocketUrl = this.options.publicRelayWebSocketUrl;
    return {
      ...grant,
      url: buildRelayUrl(urlInput),
    };
  }

  async shareState(): Promise<RelayShareState> {
    if (!this.currentRelayRoomId) {
      return {
        localPath: this.options.localFileService.getSummary().absolutePath,
        relayRoomId: null,
        hostOnline: false,
        hostSessionId: null,
        sharedRevision: null,
        lastSharedHash: null,
        links: [],
        sessions: [],
      };
    }
    return {
      ...(await this.options.relayService.listShareState(
        this.currentRelayRoomId,
        this.options.localFileService.getSummary().absolutePath,
      )),
      mode: 'relay-host',
    };
  }

  async revokeLink(grantId: string): Promise<void> {
    await this.options.relayService.revokeAccessGrant(grantId);
  }
}

export function createLocalRelayHostController(options: CreateLocalRelayHostControllerOptions): LocalRelayHostController {
  return new DefaultLocalRelayHostController(options);
}

class DefaultLocalRelayMirrorController implements LocalRelayMirrorController {
  private socket: WebSocket | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lastAcceptedLocalHash: string | null = null;
  private lastAcceptedSharedHash: string | null = null;
  private lastAcceptedSharedRevision: number | null = null;
  private lastHostSessionId: string | null = null;
  private accessRole: RelayAccessRole | null = null;
  private grantId: string | null = null;
  private sessionId: string | null = null;
  private pendingProposalId: string | null = null;
  private hostOnline = false;
  private sawHostOffline = false;
  private applyingRemote = false;

  constructor(private readonly options: CreateLocalRelayMirrorControllerOptions) {}

  private mirrorHelloMessage() {
    return {
      type: 'hello',
      relayRoomId: this.options.relayRoomId,
      token: this.options.token,
      clientId: this.options.clientId,
      clientKind: 'daemon',
      displayName: this.options.displayName ?? 'Local mirror',
    };
  }

  private recordHelloAck(message: {
    grantId?: string;
    sessionId?: string | null;
    role?: RelayAccessRole;
    hostOnline?: boolean;
    hostSessionId?: string | null;
    sharedRevision?: number;
    lastSharedHash?: string | null;
  }): { sharedRevision: number; sharedHash: string | null; hostSessionId: string | null } {
    if (!message.hostOnline) throw new Error('host_offline');
    const sharedRevision = Number(message.sharedRevision ?? 0);
    const sharedHash = message.lastSharedHash ?? null;
    const hostSessionId = message.hostSessionId ?? null;
    this.hostOnline = true;
    this.grantId = message.grantId ?? this.grantId;
    this.sessionId = message.sessionId ?? this.sessionId;
    this.accessRole = message.role ?? this.accessRole;
    this.lastHostSessionId = hostSessionId;
    this.lastAcceptedSharedRevision = sharedRevision;
    this.lastAcceptedSharedHash = sharedHash;
    return { sharedRevision, sharedHash, hostSessionId };
  }

  private assertExpectedRemoteSharedState(
    remote: { sharedRevision: number; sharedHash: string | null },
    expected: { expectedSharedRevision: number; expectedSharedHash: string },
  ): void {
    if (
      remote.sharedRevision !== expected.expectedSharedRevision ||
      relaySharedHash(remote.sharedHash) !== expected.expectedSharedHash
    ) {
      throw new Error('stale_conflict_shared_state');
    }
  }

  async verifySharedState(input: { expectedSharedRevision: number; expectedSharedHash: string }): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.options.relayWebSocketUrl);
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        socket.close(1000, 'mirror_verify_done');
        if (error) reject(error);
        else resolve();
      };
      const timeout = setTimeout(() => finish(new Error('relay_mirror_verify_timeout')), 5000);
      socket.on('open', () => {
        socket.send(JSON.stringify(this.mirrorHelloMessage()));
      });
      socket.on('message', (raw) => {
        try {
          const message = JSON.parse(raw.toString()) as {
            type?: string;
            grantId?: string;
            sessionId?: string | null;
            role?: RelayAccessRole;
            hostOnline?: boolean;
            hostSessionId?: string | null;
            sharedRevision?: number;
            lastSharedHash?: string | null;
          };
          if (message.type !== 'hello_ack') return;
          const remote = this.recordHelloAck(message);
          this.assertExpectedRemoteSharedState(remote, input);
          finish();
        } catch (error) {
          finish(error);
        }
      });
      socket.on('error', finish);
      socket.on('close', () => {
        if (!settled) finish(new Error('relay_mirror_verify_closed'));
      });
    });
  }

  async publishResolvedState(input: {
    yjsState: Uint8Array;
    expectedSharedRevision: number;
    expectedSharedHash: string;
  }): Promise<{ sharedRevision: number; sharedHash: string | null; hostSessionId: string | null }> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.options.relayWebSocketUrl);
      const proposalId = randomUUID();
      let settled = false;
      let sentProposal = false;
      const finish = (
        error: unknown,
        result?: { sharedRevision: number; sharedHash: string | null; hostSessionId: string | null },
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        socket.close(1000, 'mirror_publish_done');
        if (error) reject(error);
        else resolve(result!);
      };
      const timeout = setTimeout(() => finish(new Error('relay_mirror_publish_timeout')), 10000);
      socket.on('open', () => {
        socket.send(JSON.stringify(this.mirrorHelloMessage()));
      });
      socket.on('message', (raw) => {
        try {
          const message = JSON.parse(raw.toString()) as {
            type?: string;
            grantId?: string;
            sessionId?: string | null;
            role?: RelayAccessRole;
            hostOnline?: boolean;
            hostSessionId?: string | null;
            sharedRevision?: number;
            lastSharedHash?: string | null;
            sharedHash?: string | null;
            proposalId?: string | null;
            reason?: string;
          };
          if (message.type === 'hello_ack') {
            const remote = this.recordHelloAck(message);
            this.assertExpectedRemoteSharedState(remote, input);
            sentProposal = true;
            socket.send(
              JSON.stringify({
                type: 'propose_update',
                proposalId,
                updateBase64: encodeBase64(input.yjsState),
                replace: true,
              }),
            );
            return;
          }
          if (message.type === 'accepted_update' && message.proposalId === proposalId) {
            const result = {
              sharedRevision: Number(message.sharedRevision ?? 0),
              sharedHash: message.sharedHash ?? null,
              hostSessionId: message.hostSessionId ?? this.lastHostSessionId,
            };
            this.lastAcceptedSharedRevision = result.sharedRevision;
            this.lastAcceptedSharedHash = result.sharedHash;
            this.lastHostSessionId = result.hostSessionId;
            finish(null, result);
            return;
          }
          if (message.type === 'rejected' && (!message.proposalId || message.proposalId === proposalId || sentProposal)) {
            finish(new Error(message.reason || 'relay_mirror_publish_rejected'));
          }
        } catch (error) {
          finish(error);
        }
      });
      socket.on('error', (error) => finish(error));
      socket.on('close', () => {
        if (!settled) finish(new Error('relay_mirror_publish_closed'));
      });
    });
  }

  async shareState(): Promise<RelayShareState> {
    const summary = this.options.localFileService.getSummary();
    const saved = this.options.localFileService.getRelayJoinState();
    return {
      mode: 'relay-mirror',
      localPath: summary.absolutePath,
      relayRoomId: saved?.relayRoomId ?? this.options.relayRoomId,
      hostOnline: this.hostOnline,
      hostSessionId: this.lastHostSessionId ?? saved?.lastHostSessionId ?? null,
      sharedRevision: this.lastAcceptedSharedRevision ?? saved?.lastAcceptedSharedRevision ?? null,
      lastSharedHash: this.lastAcceptedSharedHash ?? saved?.lastAcceptedSharedHash ?? null,
      links: [],
      sessions: [],
    };
  }

  async start(): Promise<void> {
    if (this.socket) return;
    this.lastAcceptedLocalHash = this.options.localFileService.getSummary().hash;
    const socket = new WebSocket(this.options.relayWebSocketUrl);
    this.socket = socket;
    socket.on('open', () => {
      socket.send(JSON.stringify(this.mirrorHelloMessage()));
      this.startPublishingLocalChanges();
    });
    socket.on('message', (raw) => {
      void this.handleMessage(raw.toString()).catch(() => undefined);
    });
    socket.on('close', () => {
      this.hostOnline = false;
      this.stopPublishingLocalChanges();
      if (this.socket === socket) this.socket = null;
    });
    socket.on('error', () => undefined);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('relay_mirror_connect_timeout')), 3000);
      const cleanup = () => {
        clearTimeout(timeout);
        socket.off('message', handleReadyMessage);
        socket.off('error', handleReadyError);
      };
      const handleReadyError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const handleReadyMessage = (raw: WebSocket.RawData) => {
        try {
          const message = JSON.parse(raw.toString()) as {
            type?: string;
            grantId?: string;
            sessionId?: string | null;
            role?: RelayAccessRole;
            hostOnline?: boolean;
            hostSessionId?: string | null;
            sharedRevision?: number;
            lastSharedHash?: string | null;
            yjsStateBase64?: string | null;
          };
          if (message.type !== 'hello_ack') return;
          cleanup();
          void this.handleHelloAck(message).then(resolve, reject);
        } catch {
          // Keep waiting for the relay hello acknowledgement.
        }
      };
      socket.on('message', handleReadyMessage);
      socket.on('error', handleReadyError);
    });
  }

  private startPublishingLocalChanges(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.publishLocalChangeIfNeeded().catch(() => undefined);
    }, this.options.pollIntervalMs ?? 750);
    this.timer.unref();
  }

  private stopPublishingLocalChanges(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async publishLocalChangeIfNeeded(): Promise<void> {
    if (this.applyingRemote) return;
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    if (!this.hostOnline) return;
    if (this.pendingProposalId) return;
    if (!isBackingFileAvailable(this.options.localFileService)) {
      await this.pauseMirrorForMissingBackingFile();
      return;
    }
    const summary = this.options.localFileService.getSummary();
    if (summary.conflict) return;
    if (summary.hash === this.lastAcceptedLocalHash) {
      this.socket.send(JSON.stringify({ type: 'ping' }));
      return;
    }
    const yjsState = await currentLocalYjsState(this.options.localFileService);
    const proposalId = randomUUID();
    this.pendingProposalId = proposalId;
    this.socket.send(
      JSON.stringify({
        type: 'propose_update',
        proposalId,
        updateBase64: encodeBase64(yjsState),
      }),
    );
  }

  private async handleHelloAck(message: {
    grantId?: string;
    sessionId?: string | null;
    role?: RelayAccessRole;
    hostOnline?: boolean;
    hostSessionId?: string | null;
    sharedRevision?: number;
    lastSharedHash?: string | null;
    yjsStateBase64?: string | null;
  }): Promise<void> {
    const remote = this.recordHelloAck(message);
    const sharedRevision = remote.sharedRevision;
    const sharedHash = remote.sharedHash;
    const comparableSharedHash = sharedHash ?? '';
    const currentHash = this.options.localFileService.getSummary().hash;
    const saved = this.options.localFileService.getRelayJoinState();
    const localChanged = Boolean(saved && currentHash !== saved.lastAcceptedLocalHash);
    const sharedChanged = Boolean(
      saved &&
        (sharedRevision !== saved.lastAcceptedSharedRevision || comparableSharedHash !== saved.lastAcceptedSharedHash),
    );

    if (localChanged && sharedChanged) {
      if (message.yjsStateBase64) {
        await this.options.localFileService.openReconnectConflict({
          relayRoomId: this.options.relayRoomId,
          sharedYjsStateBase64: message.yjsStateBase64,
          sharedHash,
          sharedRevision,
          baseYjsStateBase64: saved?.lastAcceptedYjsStateBase64 ?? null,
          baseHash: saved?.lastAcceptedLocalHash ?? null,
        });
      } else {
        await this.options.localFileService.pauseForRelayConflict(
          'Relay reconnect conflict. Review needed before syncing resumes.',
        );
      }
      this.socket?.close(4009, 'relay_reconnect_conflict');
      throw new Error('relay_reconnect_conflict_plan3_required');
    }

    this.lastAcceptedSharedRevision = sharedRevision;
    this.lastAcceptedSharedHash = sharedHash;
    if (message.yjsStateBase64 && (!saved || sharedChanged || !localChanged)) {
      await this.applyAcceptedState(message.yjsStateBase64, {
        sharedRevision,
        sharedHash,
        hostSessionId: this.lastHostSessionId,
      });
      return;
    }

    if (!localChanged) {
      this.lastAcceptedLocalHash = currentHash;
      await this.persistAcceptedJoinState({
        sharedRevision,
        sharedHash,
        hostSessionId: this.lastHostSessionId,
      });
    } else if (saved) {
      this.lastAcceptedLocalHash = saved.lastAcceptedLocalHash;
      this.lastAcceptedSharedRevision = saved.lastAcceptedSharedRevision;
      this.lastAcceptedSharedHash = saved.lastAcceptedSharedHash;
      this.lastHostSessionId = saved.lastHostSessionId;
    }
  }

  private async persistAcceptedJoinState(input: {
    sharedRevision: number;
    sharedHash: string | null;
    hostSessionId: string | null;
    disconnectedCleanly?: boolean;
  }): Promise<void> {
    const summary = this.options.localFileService.getSummary();
    const yjsState = await currentLocalYjsState(this.options.localFileService);
    this.lastAcceptedLocalHash = summary.hash;
    this.lastAcceptedSharedRevision = input.sharedRevision;
    this.lastAcceptedSharedHash = input.sharedHash;
    this.lastHostSessionId = input.hostSessionId;
    await this.options.localFileService.saveRelayJoinState({
      schemaVersion: 1,
      relayRoomId: this.options.relayRoomId,
      grantId: this.grantId ?? '',
      sessionId: this.sessionId ?? '',
      ...(this.accessRole ? { relayRole: this.accessRole } : {}),
      localDocId: summary.localDocId,
      absolutePath: summary.absolutePath,
      lastAcceptedLocalHash: summary.hash,
      lastAcceptedSharedHash: input.sharedHash ?? '',
      lastAcceptedSharedRevision: input.sharedRevision,
      lastAcceptedYjsStateBase64: encodeBase64(yjsState),
      lastAcceptedStateFingerprint: encodeYjsStateFingerprint(yjsState),
      lastHostSessionId: input.hostSessionId,
      disconnectedCleanly: input.disconnectedCleanly ?? true,
      updatedAt: new Date().toISOString(),
    });
  }

  private async applyAcceptedState(
    yjsStateBase64: string,
    input: { sharedRevision: number; sharedHash: string | null; hostSessionId: string | null },
  ): Promise<void> {
    if (this.options.localFileService.getCurrentConflict()) return;
    if (!isBackingFileAvailable(this.options.localFileService)) {
      await this.pauseMirrorForMissingBackingFile();
      return;
    }
    this.applyingRemote = true;
    try {
      await replaceLocalFileWithRelayState(this.options.localFileService, decodeBase64(yjsStateBase64));
      await this.persistAcceptedJoinState(input);
    } finally {
      this.applyingRemote = false;
    }
  }

  private async handleMessage(raw: string): Promise<void> {
    const message = JSON.parse(raw) as {
      type?: string;
      yjsStateBase64?: string | null;
      updateBase64?: string | null;
      proposalId?: string | null;
      sharedRevision?: number;
      sharedHash?: string | null;
      hostSessionId?: string | null;
      hostOnline?: boolean;
      reason?: string;
    };
    if (message.type === 'host_status') {
      this.hostOnline = Boolean(message.hostOnline);
      if (!this.hostOnline) {
        this.sawHostOffline = true;
        const saved = this.options.localFileService.getRelayJoinState();
        if (saved) {
          await this.options.localFileService.saveRelayJoinState({
            ...saved,
            disconnectedCleanly: false,
            updatedAt: new Date().toISOString(),
          });
        }
        return;
      }

      if (this.sawHostOffline && this.options.localFileService.getSummary().hash !== this.lastAcceptedLocalHash) {
        await this.options.localFileService.pauseForRelayConflict(
          'Relay reconnect conflict. Review needed before syncing resumes.',
        );
        this.socket?.close(4009, 'relay_reconnect_conflict');
        return;
      }
      this.sawHostOffline = false;
      return;
    }
    if (message.type === 'accepted_update') {
      const state = message.updateBase64 ?? message.yjsStateBase64;
      if (message.proposalId && message.proposalId === this.pendingProposalId) this.pendingProposalId = null;
      if (state) {
        await this.applyAcceptedState(state, {
          sharedRevision: Number(message.sharedRevision ?? this.lastAcceptedSharedRevision ?? 0),
          sharedHash: message.sharedHash ?? this.lastAcceptedSharedHash,
          hostSessionId: message.hostSessionId ?? this.lastHostSessionId,
        });
      }
      return;
    }
    if (message.type === 'rejected') {
      if (message.proposalId && message.proposalId === this.pendingProposalId) this.pendingProposalId = null;
      this.sawHostOffline = true;
      this.hostOnline = false;
      await this.options.localFileService.pauseForRelayConflict(
        'Relay reconnect conflict. Review needed before syncing resumes.',
      );
      this.socket?.close(4009, 'relay_reconnect_conflict');
      const saved = this.options.localFileService.getRelayJoinState();
      if (saved) {
        await this.options.localFileService.saveRelayJoinState({
          ...saved,
          disconnectedCleanly: false,
          updatedAt: new Date().toISOString(),
        });
      }
    }
  }

  private async pauseMirrorForMissingBackingFile(): Promise<void> {
    await pauseForMissingBackingFile(this.options.localFileService, 'mirror');
    this.hostOnline = false;
    this.stopPublishingLocalChanges();
    this.socket?.close(4008, 'mirror_file_missing');
    this.socket = null;
  }

  stop(): void {
    this.stopPublishingLocalChanges();
    this.socket?.close(1001, 'mirror_stopped');
    this.socket = null;
  }
}

export function createLocalRelayMirrorController(options: CreateLocalRelayMirrorControllerOptions): LocalRelayMirrorController {
  return new DefaultLocalRelayMirrorController(options);
}
