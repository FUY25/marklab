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
  replaceClientToken(clientToken: ProviderClientToken): void;
  disconnect(): void;
  terminate(): void;
  destroy(): void;
  status?(): unknown;
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
  let currentStatus = STATUS_OFFLINE;
  let closed = false;

  const emitStatus = (status: string) => {
    currentStatus = status;
    for (const handler of handlers) handler({ status });
  };

  const postOrQueue = (message: ProviderMessage) => {
    if (closed) return;
    if (connected) {
      channel.postMessage(message);
      return;
    }
    pendingMessages.push(message);
  };
  const requestSync = () => {
    if (closed) return;
    channel.postMessage({ type: 'sync-request', sender: providerId } satisfies ProviderMessage);
  };

  const broadcastSyncState = (target = '*') => {
    if (closed) return;
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
    if (closed) return;
    connected = true;
    emitStatus(STATUS_CONNECTED);
    flushPendingMessages();
    broadcastSyncState();
    requestSync();
    broadcastAwareness([...options.awareness.getStates().keys()]);
  };

  const transitionOffline = () => {
    if (closed) return;
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
    connected = false;
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
    replaceClientToken() {
      // The memory provider does not authenticate transport messages.
    },
    disconnect() {
      transitionOffline();
    },
    terminate() {
      transitionOffline();
      closed = true;
      window.removeEventListener('marklab:e2e-provider-status', statusEventHandler);
      channel.removeEventListener('message', messageHandler);
      channel.close();
      handlers.clear();
    },
    destroy() {
      connected = false;
      currentStatus = STATUS_OFFLINE;
      closed = true;
      ydoc.off('update', ydocUpdateHandler);
      options.awareness.off('update', awarenessUpdateHandler);
      window.removeEventListener('marklab:e2e-provider-status', statusEventHandler);
      channel.removeEventListener('message', messageHandler);
      channel.close();
      handlers.clear();
    },
    status() {
      return currentStatus;
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

  const validateClientToken = (clientToken: ProviderClientToken) => {
    if (clientToken.docId !== providerDocId) throw new Error('provider_client_token_doc_mismatch');
    if (clientToken.authorization !== 'full') throw new Error('provider_client_token_authorization_denied');
  };
  let terminated = false;
  const providerOptions = options as MarkLabYjsProviderOptions & { WebSocketPolyfill?: typeof WebSocket };
  const BaseWebSocket = providerOptions.WebSocketPolyfill ?? WebSocket;
  const GuardedWebSocket = class extends BaseWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      if (terminated) throw new Error('provider_terminated');
      super(url, protocols);
    }
  } as typeof WebSocket;
  const guardedClientTokenFactory = async () => {
    if (terminated) throw new Error('provider_terminated');
    const clientToken = await clientTokenFactory();
    if (terminated) throw new Error('provider_terminated');
    validateClientToken(clientToken);
    return clientToken;
  };
  const provider = createYjsProvider(
    ydoc,
    providerDocId,
    guardedClientTokenFactory as never,
    { ...providerOptions, WebSocketPolyfill: GuardedWebSocket } as never,
  ) as unknown as MarkLabYjsProvider & {
    clientToken?: ProviderClientToken | null;
    off?: (eventName: typeof EVENT_CONNECTION_STATUS, handler: (event: unknown) => void) => void;
  };
  const rawProvider = provider as unknown as {
    attemptToConnect?: (clientToken: ProviderClientToken) => boolean | Promise<boolean>;
    connect?: () => void | Promise<void>;
    websocket?: {
      close(): void;
      onopen: unknown;
      onmessage: unknown;
      onclose: unknown;
      onerror: unknown;
    } | null;
    reconnectSleeper?: { wake(): void } | null;
    status?: string;
    setStatus?: (status: string) => void;
    isConnecting?: boolean;
    clearHeartbeat?: () => void;
    clearConnectionTimeout?: () => void;
  };
  const listenerMap = new Map<(event: unknown) => void, (event: unknown) => void>();
  const connectionAbortResolvers = new Set<(value: boolean) => void>();
  const abortInFlightConnections = () => {
    for (const resolve of connectionAbortResolvers) resolve(true);
    connectionAbortResolvers.clear();
  };
  const originalAttemptToConnect = rawProvider.attemptToConnect?.bind(provider);
  if (originalAttemptToConnect) {
    rawProvider.attemptToConnect = (clientToken) => {
      if (terminated) return true;
      let attempt: boolean | Promise<boolean>;
      try {
        attempt = originalAttemptToConnect(clientToken);
      } catch (error) {
        if (terminated) return true;
        throw error;
      }
      let abortResolve: ((value: boolean) => void) | null = null;
      const abortPromise = new Promise<boolean>((resolve) => {
        abortResolve = (value: boolean) => {
          connectionAbortResolvers.delete(abortResolve!);
          resolve(value);
        };
        connectionAbortResolvers.add(abortResolve);
      });
      return Promise.race([
        Promise.resolve(attempt).catch((error: unknown) => {
          if (terminated) return true;
          throw error;
        }),
        abortPromise,
      ]).finally(() => {
        if (abortResolve) connectionAbortResolvers.delete(abortResolve);
      });
    };
  }
  const originalConnect = rawProvider.connect?.bind(provider);
  if (originalConnect) {
    rawProvider.connect = () => {
      if (terminated) return;
      return originalConnect();
    };
  }

  const stopReconnects = () => {
    provider.clientToken = null;
    abortInFlightConnections();
    rawProvider.clearHeartbeat?.();
    rawProvider.clearConnectionTimeout?.();
    if (rawProvider.websocket) {
      rawProvider.websocket.onopen = null;
      rawProvider.websocket.onmessage = null;
      rawProvider.websocket.onclose = null;
      rawProvider.websocket.onerror = null;
      rawProvider.websocket.close();
      rawProvider.websocket = null;
    }
    rawProvider.reconnectSleeper?.wake();
    rawProvider.isConnecting = false;
    rawProvider.setStatus?.(STATUS_OFFLINE);
  };

  return {
    on(eventName, handler) {
      const wrappedHandler = (event: unknown) => {
        if (terminated) return;
        handler(event);
      };
      listenerMap.set(handler, wrappedHandler);
      provider.on(eventName, wrappedHandler);
    },
    replaceClientToken(clientToken) {
      validateClientToken(clientToken);
      provider.clientToken = clientToken;
    },
    disconnect: provider.disconnect.bind(provider),
    terminate() {
      terminated = true;
      for (const wrappedHandler of listenerMap.values()) {
        provider.off?.(EVENT_CONNECTION_STATUS, wrappedHandler);
      }
      listenerMap.clear();
      stopReconnects();
      provider.destroy();
      stopReconnects();
    },
    destroy() {
      terminated = true;
      for (const wrappedHandler of listenerMap.values()) {
        provider.off?.(EVENT_CONNECTION_STATUS, wrappedHandler);
      }
      listenerMap.clear();
      stopReconnects();
      provider.destroy();
      stopReconnects();
    },
    status() {
      return provider.status;
    },
  };
}
