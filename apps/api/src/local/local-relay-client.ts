import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import * as Y from 'yjs';
import WebSocket from 'ws';
import type { LocalFileService } from './local-file-service';
import { encodeYjsStateFingerprint } from '../services/yjs-state-fingerprint';
import type {
  CreatedRelayAccessGrant,
  RelayAccessRole,
  RelayRoomHostService,
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
  resumeHosted(): Promise<boolean>;
  ensureHosted(): Promise<{ relayRoomId: string; hostSessionId: string }>;
  start(): Promise<void>;
  stop(): void;
  createLink(role: RelayAccessRole): Promise<CreatedRelayAccessGrant & { url: string }>;
  shareState(): Promise<RelayShareState>;
  verifySharedState(input: { expectedSharedRevision: number; expectedSharedHash: string }): Promise<void>;
  publishResolvedState(input: {
    relayRoomId: string;
    yjsState: Uint8Array;
    sharedHash: string;
    expectedSharedRevision: number;
    expectedSharedHash: string;
  }): Promise<{ sharedRevision: number; sharedHash: string | null; hostSessionId: string | null }>;
  revokeLink(grantId: string): Promise<void>;
}

export interface LocalRelayMirrorController {
  start(): Promise<void>;
  stop(): void;
  shareState(): Promise<RelayShareState>;
  verifySharedState(input: { expectedSharedRevision: number; expectedSharedHash: string }): Promise<void>;
  publishResolvedState(input: {
    yjsState: Uint8Array;
    sharedHash?: string;
    expectedSharedRevision: number;
    expectedSharedHash: string;
  }): Promise<{ sharedRevision: number; sharedHash: string | null; hostSessionId: string | null }>;
}

export interface CreateLocalRelayHostControllerOptions {
  localFileService: LocalFileService;
  relayService: RelayRoomHostService;
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
  suggestedFilename?: string;
}): string {
  const url = new URL(`/relay/${encodeURIComponent(input.relayRoomId)}`, input.publicWebUrl);
  url.searchParams.set('token', input.token);
  url.searchParams.set('mode', input.role);
  if (input.suggestedFilename) url.searchParams.set('filename', input.suggestedFilename);
  if (input.publicApiUrl) url.searchParams.set('apiUrl', input.publicApiUrl);
  if (input.publicRelayWebSocketUrl) url.searchParams.set('wsUrl', input.publicRelayWebSocketUrl);
  return url.toString();
}

function relaySharedHash(value: string | null | undefined): string {
  return value ?? '';
}

function relayFailureMessage(
  message: { reason?: string | null; error?: string | null },
  fallback: string,
): string {
  return message.reason || message.error || fallback;
}

function isReconnectConflictRejection(reason: string): boolean {
  return reason === 'host_offline' || reason === 'host_lease_expired';
}

interface PendingHostPublish {
  sharedHash: string;
  expectedSharedRevision: number;
  timer: NodeJS.Timeout;
  resolve(result: { sharedRevision: number; sharedHash: string | null; hostSessionId: string | null }): void;
  reject(error: Error): void;
}

function relayWebSocketOrigin(relayWebSocketUrl: string): string | undefined {
  try {
    const url = new URL(relayWebSocketUrl);
    const protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
    return `${protocol}//${url.host}`;
  } catch {
    return undefined;
  }
}

function connectRelayWebSocket(relayWebSocketUrl: string): WebSocket {
  const origin = relayWebSocketOrigin(relayWebSocketUrl);
  return new WebSocket(relayWebSocketUrl, origin ? { headers: { Origin: origin } } : undefined);
}

async function currentLocalYjsState(localFileService: LocalFileService): Promise<Uint8Array> {
  const loaded = await localFileService.loadRoomState(localFileService.roomName);
  if (!loaded) throw new Error('local_room_not_found');
  return loaded.yjsState;
}

async function applyRelayUpdateToLocalFile(localFileService: LocalFileService, update: Uint8Array): Promise<Uint8Array | null> {
  const loaded = await localFileService.loadRoomState(localFileService.roomName);
  if (!loaded) throw new Error('local_room_not_found');
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, loaded.yjsState);
    Y.applyUpdate(doc, update);
    const nextState = Y.encodeStateAsUpdate(doc);
    const stored = await localFileService.storeRoomState(localFileService.roomName, nextState, loaded.stateFingerprint);
    if (!stored.stored) return null;
    return currentLocalYjsState(localFileService);
  } finally {
    doc.destroy();
  }
}

async function replaceLocalFileWithRelayState(localFileService: LocalFileService, yjsState: Uint8Array): Promise<Uint8Array | null> {
  const loaded = await localFileService.loadRoomState(localFileService.roomName);
  if (!loaded) throw new Error('local_room_not_found');
  const stored = await localFileService.storeRoomState(localFileService.roomName, yjsState, loaded.stateFingerprint);
  if (!stored.stored) return null;
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
  private lastSharedRevision: number | null = null;
  private lastSharedHash: string | null = null;
  private handlingProposal = false;
  private messageChain: Promise<void> = Promise.resolve();
  private pendingHostPublish: PendingHostPublish | null = null;
  private pendingLocalHostPublishHash: string | null = null;

  constructor(private readonly options: CreateLocalRelayHostControllerOptions) {}

  get relayRoomId(): string | null {
    return this.currentRelayRoomId;
  }

  private async saveCurrentHostState(): Promise<void> {
    const relayRoomId = this.currentRelayRoomId;
    const hostToken = this.currentHostToken;
    if (!relayRoomId || !hostToken) return;
    const summary = this.options.localFileService.getSummary();
    await this.options.localFileService.saveRelayHostState({
      schemaVersion: 1,
      relayRoomId,
      hostAuthToken: hostToken,
      localDocId: summary.localDocId,
      absolutePath: summary.absolutePath,
      lastHostSessionId: this.currentHostSessionId,
      lastPublishedHash: this.lastPublishedHash,
      lastSharedRevision: this.lastSharedRevision,
      lastSharedHash: this.lastSharedHash,
      updatedAt: new Date().toISOString(),
    });
  }

  private loadSavedHostState(): boolean {
    const saved = this.options.localFileService.getRelayHostState();
    if (!saved?.relayRoomId || !saved.hostAuthToken) return false;
    this.currentRelayRoomId = saved.relayRoomId;
    this.currentHostSessionId = `host_${randomUUID()}`;
    this.currentHostToken = saved.hostAuthToken;
    this.lastPublishedHash = saved.lastPublishedHash ?? null;
    this.lastSharedRevision = saved.lastSharedRevision ?? null;
    this.lastSharedHash = saved.lastSharedHash ?? saved.lastPublishedHash ?? null;
    this.options.relayService.rememberHostToken?.(saved.relayRoomId, saved.hostAuthToken);
    return true;
  }

  private clearHostState(): void {
    this.currentRelayRoomId = null;
    this.currentHostSessionId = null;
    this.currentHostToken = null;
    this.lastPublishedHash = null;
    this.lastSharedRevision = null;
    this.lastSharedHash = null;
    this.pendingLocalHostPublishHash = null;
  }

  async resumeHosted(): Promise<boolean> {
    if (this.currentRelayRoomId && this.currentHostSessionId) {
      await this.start();
      return true;
    }

    if (this.loadSavedHostState()) {
      try {
        await this.start();
        await this.saveCurrentHostState();
        return true;
      } catch {
        this.stop();
        this.clearHostState();
        return false;
      }
    }

    return false;
  }

  async ensureHosted(): Promise<{ relayRoomId: string; hostSessionId: string }> {
    if (await this.resumeHosted()) {
      return { relayRoomId: this.currentRelayRoomId!, hostSessionId: this.currentHostSessionId! };
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
    this.lastSharedRevision = room.sharedRevision;
    this.lastSharedHash = room.lastSharedHash ?? summary.hash;
    await this.start();
    await this.saveCurrentHostState();
    return { relayRoomId: room.relayRoomId, hostSessionId };
  }

  async start(): Promise<void> {
    const relayRoomId = this.currentRelayRoomId;
    const hostSessionId = this.currentHostSessionId;
    const hostToken = this.currentHostToken;
    if (!relayRoomId || !hostSessionId || !hostToken || this.socket) return;

    const socket = connectRelayWebSocket(this.options.relayWebSocketUrl);
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
      this.rejectPendingHostPublish(new Error('relay_host_publish_closed'));
      this.pendingLocalHostPublishHash = null;
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
          const message = JSON.parse(raw.toString()) as {
            type?: string;
            sharedRevision?: number;
            lastSharedHash?: string | null;
            hostSessionId?: string | null;
            yjsStateBase64?: string | null;
          };
          if (message.type !== 'hello_ack') return;
          cleanup();
          void this.handleHostHelloAck(message).then(resolve, reject);
        } catch {
          // Keep waiting for the relay hello acknowledgement.
        }
      };
      socket.on('message', handleReadyMessage);
      socket.on('error', handleReadyError);
    });
    if (this.socket === socket && !this.options.localFileService.getSummary().conflict) {
      this.startPublishingLocalChanges();
    }
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
    if (this.pendingHostPublish) return;
    if (this.pendingLocalHostPublishHash) {
      this.socket.send(JSON.stringify({ type: 'ping' }));
      return;
    }
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
    const expectedSharedRevision = this.lastSharedRevision;
    const expectedSharedHash = this.lastSharedHash;
    this.pendingLocalHostPublishHash = summary.hash;
    try {
      this.socket.send(
        JSON.stringify({
          type: 'host_update',
          yjsStateBase64: encodeBase64(yjsState),
          sharedHash: summary.hash,
          ...(expectedSharedRevision !== null ? { expectedSharedRevision } : {}),
          ...(expectedSharedHash !== null ? { expectedSharedHash: relaySharedHash(expectedSharedHash) } : {}),
        }),
      );
    } catch (error) {
      this.pendingLocalHostPublishHash = null;
      throw error;
    }
  }

  private async handleMessage(raw: string): Promise<void> {
    const activeSocket = this.socket;
    if (!activeSocket || activeSocket.readyState !== WebSocket.OPEN) return;
    const message = JSON.parse(raw) as {
      type: string;
      proposalId?: string;
      updateBase64?: string;
      sharedRevision?: number;
      sharedHash?: string;
      lastSharedHash?: string | null;
      hostSessionId?: string | null;
      replace?: boolean;
      reason?: string;
      error?: string;
    };
    if (message.type === 'accepted_update') {
      await this.recordSharedStateFromRelayMessage(message);
      await this.resolvePendingHostPublish(message);
      await this.resolvePendingLocalHostPublish(message);
      return;
    }
    if (message.type === 'rejected' || message.type === 'error') {
      this.rejectPendingHostPublish(new Error(relayFailureMessage(message, 'relay_host_publish_rejected')));
      this.pendingLocalHostPublishHash = null;
      return;
    }
    if (message.type !== 'proposal' || !message.proposalId || !message.updateBase64) return;

    if (!isBackingFileAvailable(this.options.localFileService)) {
      activeSocket.send(
        JSON.stringify({
          type: 'host_reject',
          proposalId: message.proposalId,
          reason: 'host_file_missing',
        }),
      );
      await this.pauseHostForMissingBackingFile();
      return;
    }

    try {
      this.handlingProposal = true;
      await this.recordSharedStateFromRelayMessage(message);
      const acceptedState = message.replace
        ? await replaceLocalFileWithRelayState(this.options.localFileService, decodeBase64(message.updateBase64))
        : await applyRelayUpdateToLocalFile(this.options.localFileService, decodeBase64(message.updateBase64));
      if (!acceptedState) throw new Error('conflict_required');
      const summary = this.options.localFileService.getSummary();
      this.lastPublishedHash = summary.hash;
      await this.saveCurrentHostState();
      activeSocket.send(
        JSON.stringify({
          type: 'host_ack',
          proposalId: message.proposalId,
          yjsStateBase64: encodeBase64(acceptedState),
          sharedHash: summary.hash,
        }),
      );
    } catch {
      if (activeSocket.readyState === WebSocket.OPEN) {
        activeSocket.send(
          JSON.stringify({
            type: 'host_reject',
            proposalId: message.proposalId,
            reason: 'host_write_failed',
          }),
        );
      }
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

  private async handleHostHelloAck(message: {
    sharedRevision?: number;
    lastSharedHash?: string | null;
    hostSessionId?: string | null;
    yjsStateBase64?: string | null;
  }): Promise<void> {
    const previousPublishedHash = this.lastPublishedHash;
    const previousSharedRevision = this.lastSharedRevision;
    const previousSharedHash = this.lastSharedHash;
    const remoteSharedRevision = typeof message.sharedRevision === 'number' ? message.sharedRevision : null;
    const remoteSharedHash = message.lastSharedHash ?? null;
    await this.recordSharedStateFromRelayMessage(message);
    const sharedChanged = (
      (previousSharedRevision !== null && remoteSharedRevision !== null && previousSharedRevision !== remoteSharedRevision)
      || (previousSharedHash !== null && remoteSharedHash !== null && relaySharedHash(previousSharedHash) !== relaySharedHash(remoteSharedHash))
    );
    if (!sharedChanged) return;

    const summary = this.options.localFileService.getSummary();
    if (summary.conflict) return;
    const localChanged = previousPublishedHash !== null
      ? summary.hash !== previousPublishedHash
      : previousSharedHash !== null && summary.hash !== relaySharedHash(previousSharedHash);
    if (!message.yjsStateBase64) {
      await this.options.localFileService.pauseForRelayConflict(
        'Relay reconnect conflict. Review needed before syncing resumes.',
      );
      this.stopPublishingLocalChanges();
      this.socket?.close(4009, 'relay_reconnect_conflict');
      return;
    }
    if (localChanged) {
      await this.openHostReconnectConflictFromRelay({
        yjsStateBase64: message.yjsStateBase64,
        sharedHash: remoteSharedHash,
        sharedRevision: remoteSharedRevision,
        baseHash: previousPublishedHash ?? previousSharedHash ?? null,
      });
      return;
    }

    const acceptedState = await replaceLocalFileWithRelayState(this.options.localFileService, decodeBase64(message.yjsStateBase64));
    if (!acceptedState) {
      await this.openHostReconnectConflictFromRelay({
        yjsStateBase64: message.yjsStateBase64,
        sharedHash: remoteSharedHash,
        sharedRevision: remoteSharedRevision,
        baseHash: previousPublishedHash ?? previousSharedHash ?? null,
      });
      return;
    }
    const updatedSummary = this.options.localFileService.getSummary();
    this.lastPublishedHash = updatedSummary.hash;
    await this.saveCurrentHostState();
  }

  private async openHostReconnectConflictFromRelay(input: {
    yjsStateBase64: string;
    sharedHash: string | null;
    sharedRevision: number | null;
    baseHash: string | null;
  }): Promise<void> {
    const relayRoomId = this.currentRelayRoomId;
    if (!relayRoomId) return;
    await this.options.localFileService.openReconnectConflict({
      relayRoomId,
      sharedYjsStateBase64: input.yjsStateBase64,
      sharedHash: input.sharedHash,
      sharedRevision: input.sharedRevision ?? this.lastSharedRevision ?? 0,
      expectedSharedRevision: input.sharedRevision ?? this.lastSharedRevision ?? 0,
      expectedSharedHash: relaySharedHash(input.sharedHash ?? this.lastSharedHash),
      baseHash: input.baseHash,
    });
    await this.options.relayService.markHostOffline(relayRoomId, this.currentHostSessionId);
    this.stopPublishingLocalChanges();
    this.socket?.close(4009, 'relay_reconnect_conflict');
  }

  stop(): void {
    this.stopPublishingLocalChanges();
    this.rejectPendingHostPublish(new Error('relay_host_publish_closed'));
    this.pendingLocalHostPublishHash = null;
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
      suggestedFilename: basename(this.options.localFileService.getSummary().absolutePath),
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

  async verifySharedState(input: { expectedSharedRevision: number; expectedSharedHash: string }): Promise<void> {
    const shareState = await this.shareState();
    if (shareState.relayRoomId !== this.currentRelayRoomId || !shareState.hostOnline) throw new Error('host_offline');
    if (
      shareState.sharedRevision !== input.expectedSharedRevision ||
      relaySharedHash(shareState.lastSharedHash) !== input.expectedSharedHash
    ) {
      throw new Error('stale_conflict_shared_state');
    }
  }

  async publishResolvedState(input: {
    relayRoomId: string;
    yjsState: Uint8Array;
    sharedHash: string;
    expectedSharedRevision: number;
    expectedSharedHash: string;
  }): Promise<{ sharedRevision: number; sharedHash: string | null; hostSessionId: string | null }> {
    if (this.currentRelayRoomId !== input.relayRoomId) throw new Error('forbidden');
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      if (this.socket && this.socket.readyState !== WebSocket.OPEN) {
        this.socket.close();
        this.socket = null;
      }
      await this.start();
    }
    await this.verifySharedState(input);
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error('host_offline');
    if (this.pendingHostPublish || this.handlingProposal) throw new Error('proposal_in_flight');
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingHostPublish?.timer === timer) this.pendingHostPublish = null;
        reject(new Error('relay_host_publish_timeout'));
      }, 10000);
      timer.unref();
      this.pendingHostPublish = {
        sharedHash: input.sharedHash,
        expectedSharedRevision: input.expectedSharedRevision,
        timer,
        resolve,
        reject,
      };
      try {
        this.socket?.send(
          JSON.stringify({
            type: 'host_update',
            yjsStateBase64: encodeBase64(input.yjsState),
            sharedHash: input.sharedHash,
            expectedSharedRevision: input.expectedSharedRevision,
            expectedSharedHash: input.expectedSharedHash,
            replace: true,
          }),
        );
      } catch (error) {
        this.rejectPendingHostPublish(error instanceof Error ? error : new Error('relay_host_publish_failed'));
      }
    });
  }

  private rejectPendingHostPublish(error: Error): void {
    const pending = this.pendingHostPublish;
    if (!pending) return;
    this.pendingHostPublish = null;
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  private async recordSharedStateFromRelayMessage(message: {
    sharedRevision?: number;
    sharedHash?: string | null;
    lastSharedHash?: string | null;
    hostSessionId?: string | null;
  }): Promise<void> {
    const sharedRevision = typeof message.sharedRevision === 'number' ? message.sharedRevision : null;
    const sharedHash = message.sharedHash ?? message.lastSharedHash ?? null;
    if (sharedRevision === null && sharedHash === null && !message.hostSessionId) return;
    if (sharedRevision !== null) this.lastSharedRevision = sharedRevision;
    if (sharedHash !== null) this.lastSharedHash = sharedHash;
    this.currentHostSessionId = message.hostSessionId ?? this.currentHostSessionId;
    await this.saveCurrentHostState();
  }

  private async resolvePendingHostPublish(message: {
    sharedRevision?: number;
    sharedHash?: string | null;
    hostSessionId?: string | null;
  }): Promise<void> {
    const pending = this.pendingHostPublish;
    if (!pending) return;
    const sharedRevision = Number(message.sharedRevision ?? -1);
    const sharedHash = message.sharedHash ?? null;
    if (sharedRevision <= pending.expectedSharedRevision || relaySharedHash(sharedHash) !== pending.sharedHash) return;
    this.pendingHostPublish = null;
    clearTimeout(pending.timer);
    this.lastPublishedHash = pending.sharedHash;
    this.currentHostSessionId = message.hostSessionId ?? this.currentHostSessionId;
    await this.saveCurrentHostState();
    pending.resolve({
      sharedRevision,
      sharedHash,
      hostSessionId: this.currentHostSessionId,
    });
  }

  private async resolvePendingLocalHostPublish(message: {
    proposalId?: string | null;
    sharedHash?: string | null;
    hostSessionId?: string | null;
  }): Promise<void> {
    const pendingHash = this.pendingLocalHostPublishHash;
    if (!pendingHash || message.proposalId) return;
    if (relaySharedHash(message.sharedHash) !== pendingHash) return;
    this.pendingLocalHostPublishHash = null;
    this.lastPublishedHash = pendingHash;
    this.currentHostSessionId = message.hostSessionId ?? this.currentHostSessionId;
    await this.saveCurrentHostState();
  }

  async revokeLink(grantId: string): Promise<void> {
    if (this.currentRelayRoomId) {
      await this.options.relayService
        .listShareState(this.currentRelayRoomId, this.options.localFileService.getSummary().absolutePath)
        .catch(() => undefined);
    }
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
      const socket = connectRelayWebSocket(this.options.relayWebSocketUrl);
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
            reason?: string | null;
            error?: string | null;
          };
          if (message.type === 'error' || message.type === 'rejected') {
            finish(new Error(relayFailureMessage(message, 'relay_mirror_verify_rejected')));
            return;
          }
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
    sharedHash?: string;
    expectedSharedRevision: number;
    expectedSharedHash: string;
  }): Promise<{ sharedRevision: number; sharedHash: string | null; hostSessionId: string | null }> {
    return new Promise((resolve, reject) => {
      const socket = connectRelayWebSocket(this.options.relayWebSocketUrl);
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
            reason?: string | null;
            error?: string | null;
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
                expectedSharedRevision: input.expectedSharedRevision,
                expectedSharedHash: input.expectedSharedHash,
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
            if (
              result.sharedRevision <= input.expectedSharedRevision ||
              (input.sharedHash && relaySharedHash(result.sharedHash) !== input.sharedHash)
            ) {
              finish(new Error('relay_shared_state_not_accepted'));
              return;
            }
            this.lastAcceptedSharedRevision = result.sharedRevision;
            this.lastAcceptedSharedHash = result.sharedHash;
            this.lastHostSessionId = result.hostSessionId;
            finish(null, result);
            return;
          }
          if (message.type === 'error') {
            finish(new Error(relayFailureMessage(message, 'relay_mirror_publish_rejected')));
            return;
          }
          if (message.type === 'rejected' && (!message.proposalId || message.proposalId === proposalId || sentProposal)) {
            finish(new Error(relayFailureMessage(message, 'relay_mirror_publish_rejected')));
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
    const socket = connectRelayWebSocket(this.options.relayWebSocketUrl);
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
            reason?: string | null;
            error?: string | null;
          };
          if (message.type === 'error' || message.type === 'rejected') {
            cleanup();
            reject(new Error(relayFailureMessage(message, 'relay_mirror_connect_rejected')));
            return;
          }
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
    const expectedSharedRevision = this.lastAcceptedSharedRevision;
    const expectedSharedHash = this.lastAcceptedSharedHash;
    this.pendingProposalId = proposalId;
    this.socket.send(
      JSON.stringify({
        type: 'propose_update',
        proposalId,
        updateBase64: encodeBase64(yjsState),
        ...(expectedSharedRevision !== null ? { expectedSharedRevision } : {}),
        ...(expectedSharedHash !== null ? { expectedSharedHash: relaySharedHash(expectedSharedHash) } : {}),
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
          expectedSharedRevision: sharedRevision,
          expectedSharedHash: relaySharedHash(sharedHash),
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

  private async markMirrorDisconnected(): Promise<void> {
    const saved = this.options.localFileService.getRelayJoinState();
    if (!saved) return;
    await this.options.localFileService.saveRelayJoinState({
      ...saved,
      disconnectedCleanly: false,
      updatedAt: new Date().toISOString(),
    });
  }

  private async applyAcceptedState(
    yjsStateBase64: string,
    input: { sharedRevision: number; sharedHash: string | null; hostSessionId: string | null },
  ): Promise<void> {
    if (this.options.localFileService.getCurrentConflict()) {
      await this.refreshOpenConflictFromAcceptedState(yjsStateBase64, input);
      return;
    }
    if (!isBackingFileAvailable(this.options.localFileService)) {
      await this.pauseMirrorForMissingBackingFile();
      return;
    }
    this.applyingRemote = true;
    try {
      const replacedState = await replaceLocalFileWithRelayState(this.options.localFileService, decodeBase64(yjsStateBase64));
      if (!replacedState) {
        await this.refreshOpenConflictFromAcceptedState(yjsStateBase64, input);
        return;
      }
      await this.persistAcceptedJoinState(input);
    } finally {
      this.applyingRemote = false;
    }
  }

  private async refreshOpenConflictFromAcceptedState(
    yjsStateBase64: string,
    input: { sharedRevision: number; sharedHash: string | null; hostSessionId: string | null },
  ): Promise<void> {
    const saved = this.options.localFileService.getRelayJoinState();
    await this.options.localFileService.openReconnectConflict({
      relayRoomId: this.options.relayRoomId,
      sharedYjsStateBase64: yjsStateBase64,
      sharedHash: input.sharedHash,
      sharedRevision: input.sharedRevision,
      expectedSharedRevision: input.sharedRevision,
      expectedSharedHash: relaySharedHash(input.sharedHash),
      baseYjsStateBase64: saved?.lastAcceptedYjsStateBase64 ?? null,
      baseHash: saved?.lastAcceptedLocalHash ?? null,
    });
  }

  private async handleMessage(raw: string): Promise<void> {
    const message = JSON.parse(raw) as {
      type?: string;
      yjsStateBase64?: string | null;
      updateBase64?: string | null;
      proposalId?: string | null;
      sharedRevision?: number;
      sharedHash?: string | null;
      lastSharedHash?: string | null;
      hostSessionId?: string | null;
      hostOnline?: boolean;
      reason?: string | null;
      error?: string | null;
    };
    if (message.type === 'host_status') {
      this.hostOnline = Boolean(message.hostOnline);
      if (!this.hostOnline) {
        this.sawHostOffline = true;
        await this.markMirrorDisconnected();
        return;
      }

      if (this.sawHostOffline) {
        const saved = this.options.localFileService.getRelayJoinState();
        const currentHash = this.options.localFileService.getSummary().hash;
        const acceptedLocalHash = this.lastAcceptedLocalHash ?? saved?.lastAcceptedLocalHash ?? null;
        const remoteSharedRevision = Number(message.sharedRevision ?? this.lastAcceptedSharedRevision ?? saved?.lastAcceptedSharedRevision ?? 0);
        const remoteSharedHash = message.sharedHash ?? message.lastSharedHash ?? this.lastAcceptedSharedHash ?? saved?.lastAcceptedSharedHash ?? null;
        const localChanged = Boolean(acceptedLocalHash && currentHash !== acceptedLocalHash);
        const sharedChanged = Boolean(
          saved &&
            (
              remoteSharedRevision !== saved.lastAcceptedSharedRevision
              || relaySharedHash(remoteSharedHash) !== saved.lastAcceptedSharedHash
            ),
        );
        if (localChanged && sharedChanged) {
          if (message.yjsStateBase64) {
            await this.options.localFileService.openReconnectConflict({
              relayRoomId: this.options.relayRoomId,
              sharedYjsStateBase64: message.yjsStateBase64,
              sharedHash: remoteSharedHash,
              sharedRevision: remoteSharedRevision,
              expectedSharedRevision: remoteSharedRevision,
              expectedSharedHash: relaySharedHash(remoteSharedHash),
              baseYjsStateBase64: saved?.lastAcceptedYjsStateBase64 ?? null,
              baseHash: saved?.lastAcceptedLocalHash ?? null,
            });
          } else {
            await this.options.localFileService.pauseForRelayConflict(
              'Relay reconnect conflict. Review needed before syncing resumes.',
            );
          }
          this.socket?.close(4009, 'relay_reconnect_conflict');
          return;
        }
        if (!localChanged && sharedChanged && message.yjsStateBase64) {
          await this.applyAcceptedState(message.yjsStateBase64, {
            sharedRevision: remoteSharedRevision,
            sharedHash: remoteSharedHash,
            hostSessionId: message.hostSessionId ?? this.lastHostSessionId,
          });
          this.sawHostOffline = false;
          return;
        }
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
      const reason = relayFailureMessage(message, 'relay_mirror_write_rejected');
      if (message.proposalId && message.proposalId === this.pendingProposalId) this.pendingProposalId = null;
      if (reason === 'proposal_in_flight') return;
      await this.markMirrorDisconnected();
      if (reason === 'relay_shared_state_not_accepted') {
        const state = message.updateBase64 ?? message.yjsStateBase64;
        if (state) {
          const saved = this.options.localFileService.getRelayJoinState();
          const sharedHash = message.sharedHash ?? message.lastSharedHash ?? this.lastAcceptedSharedHash ?? null;
          const sharedRevision = Number(message.sharedRevision ?? this.lastAcceptedSharedRevision ?? 0);
          await this.options.localFileService.openReconnectConflict({
            relayRoomId: this.options.relayRoomId,
            sharedYjsStateBase64: state,
            sharedHash,
            sharedRevision,
            expectedSharedRevision: sharedRevision,
            expectedSharedHash: relaySharedHash(sharedHash),
            baseYjsStateBase64: saved?.lastAcceptedYjsStateBase64 ?? null,
            baseHash: saved?.lastAcceptedLocalHash ?? null,
          });
          this.socket?.close(4009, 'relay_reconnect_conflict');
          return;
        }
      }
      if (!isReconnectConflictRejection(reason)) {
        this.hostOnline = false;
        this.stopPublishingLocalChanges();
        this.socket?.close(4003, reason);
        return;
      }
      this.sawHostOffline = true;
      this.hostOnline = false;
      return;
    }
    if (message.type === 'error') {
      const reason = relayFailureMessage(message, 'relay_mirror_error');
      this.pendingProposalId = null;
      await this.markMirrorDisconnected();
      this.hostOnline = false;
      this.stopPublishingLocalChanges();
      this.socket?.close(4003, reason);
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
