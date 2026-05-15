import {
  createYjsProvider,
  EVENT_CONNECTION_STATUS,
  STATUS_CONNECTED,
  STATUS_OFFLINE,
} from '@y-sweet/client';
import { applyAwarenessUpdate, encodeAwarenessUpdate, type Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import type { ProviderClientToken } from '../api/collab-session';

export interface MarkLabYjsProvider {
  on(eventName: typeof EVENT_CONNECTION_STATUS, handler: (event: unknown) => void): void;
  disconnect(): void;
  destroy(): void;
}

export interface MarkLabYjsProviderOptions {
  awareness: Awareness;
  initialClientToken: ProviderClientToken;
  connect: boolean;
  offlineSupport: boolean;
  showDebuggerLink: boolean;
}

function clientTokenUsesMemoryProvider(clientToken: ProviderClientToken): boolean {
  return clientToken.url.startsWith('memory://') || clientToken.baseUrl.startsWith('memory://');
}

type ProviderMessage =
  | { type: 'sync-request'; sender: string }
  | { type: 'sync-state'; sender: string; target: string; update: Uint8Array; awarenessUpdate: Uint8Array }
  | { type: 'doc-update'; sender: string; update: Uint8Array }
  | { type: 'awareness-update'; sender: string; update: Uint8Array };

function createMemoryProvider(
  ydoc: Y.Doc,
  providerDocId: string,
  options: MarkLabYjsProviderOptions,
): MarkLabYjsProvider {
  const channel = new BroadcastChannel(`marklab:collab-web:e2e:${providerDocId}`);
  const providerId = crypto.randomUUID();
  const remoteOrigin = { providerId, source: 'marklab-memory-provider' };
  const handlers = new Set<(event: unknown) => void>();
  const pendingMessages: ProviderMessage[] = [];
  let connected = false;

  const emitStatus = (status: string) => {
    for (const handler of handlers) handler({ status });
  };

  const postOrQueue = (message: ProviderMessage) => {
    if (connected) {
      channel.postMessage(message);
      return;
    }
    pendingMessages.push(message);
  };

  const requestSync = () => {
    channel.postMessage({ type: 'sync-request', sender: providerId } satisfies ProviderMessage);
  };

  const broadcastSyncState = (target = '*') => {
    channel.postMessage({
      type: 'sync-state',
      sender: providerId,
      target,
      update: Y.encodeStateAsUpdate(ydoc),
      awarenessUpdate: encodeAwarenessUpdate(options.awareness, [...options.awareness.getStates().keys()]),
    } satisfies ProviderMessage);
  };

  const flushPendingMessages = () => {
    while (pendingMessages.length > 0) {
      const message = pendingMessages.shift();
      if (message) channel.postMessage(message);
    }
  };

  const transitionOnline = () => {
    connected = true;
    emitStatus(STATUS_CONNECTED);
    flushPendingMessages();
    broadcastSyncState();
    requestSync();
    broadcastAwareness([...options.awareness.getStates().keys()]);
  };

  const transitionOffline = () => {
    connected = false;
    emitStatus(STATUS_OFFLINE);
  };

  const broadcastAwareness = (clientIds: number[]) => {
    if (clientIds.length === 0) return;
    postOrQueue({
      type: 'awareness-update',
      sender: providerId,
      update: encodeAwarenessUpdate(options.awareness, clientIds),
    } satisfies ProviderMessage);
  };

  const ydocUpdateHandler = (update: Uint8Array, origin: unknown) => {
    if (origin === remoteOrigin) return;
    postOrQueue({ type: 'doc-update', sender: providerId, update: new Uint8Array(update) } satisfies ProviderMessage);
  };
  ydoc.on('update', ydocUpdateHandler);

  const awarenessUpdateHandler = (
    event: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    if (origin === remoteOrigin) return;
    broadcastAwareness([...event.added, ...event.updated, ...event.removed]);
  };
  options.awareness.on('update', awarenessUpdateHandler);

  const messageHandler = (event: MessageEvent<ProviderMessage>) => {
    const message = event.data;
    if (!message || message.sender === providerId) return;
    if (!connected) return;
    if (message.type === 'doc-update') {
      Y.applyUpdate(ydoc, new Uint8Array(message.update), remoteOrigin);
      return;
    }
    if (message.type === 'awareness-update') {
      applyAwarenessUpdate(options.awareness, message.update, remoteOrigin);
      return;
    }
    if (message.type === 'sync-request') {
      broadcastSyncState(message.sender);
      return;
    }
    if (message.type === 'sync-state' && (message.target === providerId || message.target === '*')) {
      Y.applyUpdate(ydoc, new Uint8Array(message.update), remoteOrigin);
      applyAwarenessUpdate(options.awareness, message.awarenessUpdate, remoteOrigin);
    }
  };
  channel.addEventListener('message', messageHandler);

  const statusEventHandler = (event: Event) => {
    const detail = (event as CustomEvent<{ providerDocId?: string; status?: string }>).detail;
    if (!detail?.status) return;
    if (detail.providerDocId && detail.providerDocId !== providerDocId) return;
    if (detail.status === STATUS_CONNECTED) {
      transitionOnline();
      return;
    }
    if (detail.status === STATUS_OFFLINE) {
      transitionOffline();
      return;
    }
    emitStatus(detail.status);
  };
  window.addEventListener('marklab:e2e-provider-status', statusEventHandler);

  if (options.connect) {
    window.setTimeout(() => {
      transitionOnline();
    }, 0);
  }

  return {
    on(eventName, handler) {
      if (eventName === EVENT_CONNECTION_STATUS) handlers.add(handler);
    },
    disconnect() {
      transitionOffline();
    },
    destroy() {
      ydoc.off('update', ydocUpdateHandler);
      options.awareness.off('update', awarenessUpdateHandler);
      window.removeEventListener('marklab:e2e-provider-status', statusEventHandler);
      channel.removeEventListener('message', messageHandler);
      channel.close();
      handlers.clear();
    },
  };
}

export function createMarkLabYjsProvider(
  ydoc: Y.Doc,
  providerDocId: string,
  clientTokenFactory: () => Promise<ProviderClientToken>,
  options: MarkLabYjsProviderOptions,
): MarkLabYjsProvider {
  if (clientTokenUsesMemoryProvider(options.initialClientToken)) {
    return createMemoryProvider(ydoc, providerDocId, options);
  }

  return createYjsProvider(
    ydoc,
    providerDocId,
    clientTokenFactory as never,
    options as never,
  ) as MarkLabYjsProvider;
}
