// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import type { ProviderClientToken } from '@marklab/collab-editor';

let capturedAuthEndpoint: (() => Promise<ProviderClientToken>) | null = null;
let capturedWebSocketPolyfill: typeof WebSocket | null = null;
let capturedProvider: {
  clientToken: ProviderClientToken | null;
  status: string;
  websocket: {
    close: ReturnType<typeof vi.fn>;
    onopen: unknown;
    onmessage: unknown;
    onclose: ((event?: unknown) => void) | null;
    onerror: unknown;
  } | null;
  reconnectSleeper: { wake: ReturnType<typeof vi.fn> };
  isConnecting: boolean;
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  setStatus: ReturnType<typeof vi.fn>;
  clearHeartbeat: ReturnType<typeof vi.fn>;
  clearConnectionTimeout: ReturnType<typeof vi.fn>;
} | null = null;

vi.mock('@y-sweet/client', () => ({
  EVENT_CONNECTION_STATUS: 'connection-status',
  STATUS_CONNECTED: 'connected',
  STATUS_CONNECTING: 'connecting',
  STATUS_ERROR: 'error',
  STATUS_OFFLINE: 'offline',
  createYjsProvider: vi.fn((_doc: Y.Doc, _providerDocId: string, authEndpoint: () => Promise<ProviderClientToken>, options: { WebSocketPolyfill: typeof WebSocket }) => {
    capturedAuthEndpoint = authEndpoint;
    capturedWebSocketPolyfill = options.WebSocketPolyfill;
    capturedProvider = {
      clientToken: null,
      status: 'connected',
      websocket: null,
      reconnectSleeper: { wake: vi.fn() },
      isConnecting: true,
      on: vi.fn(),
      off: vi.fn(),
      disconnect: vi.fn(),
      destroy: vi.fn(),
      setStatus: vi.fn(),
      clearHeartbeat: vi.fn(),
      clearConnectionTimeout: vi.fn(),
    };
    return capturedProvider;
  }),
}));

const { createMarkLabYjsProvider } = await import('./yjs-provider');

function clientToken(input: Partial<ProviderClientToken> = {}): ProviderClientToken {
  return {
    docId: 'provider_doc_1',
    url: 'ws://api.example.test/d/provider_doc_1/ws/',
    baseUrl: 'https://api.example.test/d/provider_doc_1',
    token: 'ysweet_client_token',
    authorization: 'full',
    ...input,
  };
}

describe('MarkLab Yjs provider wrapper', () => {
  it('rejects replacement client tokens for the wrong provider document', () => {
    const ydoc = new Y.Doc();
    const provider = createMarkLabYjsProvider(
      ydoc,
      'provider_doc_1',
      async () => clientToken(),
      {
        awareness: new Awareness(ydoc),
        initialClientToken: clientToken(),
        connect: true,
        offlineSupport: false,
        showDebuggerLink: false,
      },
    );

    expect(() => provider.replaceClientToken(clientToken({ docId: 'provider_doc_2' }))).toThrow('provider_client_token_doc_mismatch');
    expect(() => provider.replaceClientToken(clientToken({ authorization: 'read-only' }))).toThrow('provider_client_token_authorization_denied');
    provider.replaceClientToken(clientToken({ token: 'refreshed' }));
    ydoc.destroy();
  });

  it('blocks future token reads and websocket construction after terminal shutdown', async () => {
    const ydoc = new Y.Doc();
    const provider = createMarkLabYjsProvider(
      ydoc,
      'provider_doc_1',
      async () => clientToken({ token: 'new_token' }),
      {
        awareness: new Awareness(ydoc),
        initialClientToken: clientToken(),
        connect: true,
        offlineSupport: false,
        showDebuggerLink: false,
      },
    );

    provider.terminate();

    await expect(capturedAuthEndpoint?.()).rejects.toThrow('provider_terminated');
    expect(() => new capturedWebSocketPolyfill!('ws://api.example.test/d/provider_doc_1/ws/provider_doc_1')).toThrow('provider_terminated');
    ydoc.destroy();
  });

  it('clears real-provider reconnect hooks during normal destroy', () => {
    const ydoc = new Y.Doc();
    const provider = createMarkLabYjsProvider(
      ydoc,
      'provider_doc_1',
      async () => clientToken(),
      {
        awareness: new Awareness(ydoc),
        initialClientToken: clientToken(),
        connect: true,
        offlineSupport: false,
        showDebuggerLink: false,
      },
    );
    const close = vi.fn();
    const onclose = vi.fn();
    const websocket = {
      close,
      onopen: vi.fn(),
      onmessage: vi.fn(),
      onclose,
      onerror: vi.fn(),
    };
    if (!capturedProvider) throw new Error('mock_provider_missing');
    capturedProvider.websocket = websocket;
    capturedProvider.destroy.mockImplementation(() => {
      websocket.onclose?.();
    });

    provider.destroy();

    expect(websocket.onopen).toBeNull();
    expect(websocket.onmessage).toBeNull();
    expect(websocket.onclose).toBeNull();
    expect(websocket.onerror).toBeNull();
    expect(close).toHaveBeenCalledTimes(1);
    expect(onclose).not.toHaveBeenCalled();
    expect(capturedProvider.reconnectSleeper.wake).toHaveBeenCalled();
    ydoc.destroy();
  });

  it('reports the memory provider offline after terminal shutdown', async () => {
    const ydoc = new Y.Doc();
    const provider = createMarkLabYjsProvider(
      ydoc,
      'provider_doc_1',
      async () => clientToken(),
      {
        awareness: new Awareness(ydoc),
        initialClientToken: clientToken({
          url: 'memory://provider_doc_1',
          baseUrl: 'memory://provider_doc_1',
        }),
        connect: true,
        offlineSupport: false,
        showDebuggerLink: false,
      },
    );

    await new Promise((resolve) => {
      window.setTimeout(resolve, 0);
    });
    expect(provider.status?.()).toBe('connected');

    provider.terminate();

    expect(provider.status?.()).toBe('offline');
    ydoc.destroy();
  });

  it('reports transient memory provider statuses instead of stale connected state', async () => {
    const ydoc = new Y.Doc();
    const provider = createMarkLabYjsProvider(
      ydoc,
      'provider_doc_1',
      async () => clientToken(),
      {
        awareness: new Awareness(ydoc),
        initialClientToken: clientToken({
          url: 'memory://provider_doc_1',
          baseUrl: 'memory://provider_doc_1',
        }),
        connect: true,
        offlineSupport: false,
        showDebuggerLink: false,
      },
    );

    await new Promise((resolve) => {
      window.setTimeout(resolve, 0);
    });
    expect(provider.status?.()).toBe('connected');

    window.dispatchEvent(new CustomEvent('marklab:e2e-provider-status', {
      detail: { providerDocId: 'provider_doc_1', status: 'error' },
    }));
    expect(provider.status?.()).toBe('error');

    window.dispatchEvent(new CustomEvent('marklab:e2e-provider-status', {
      detail: { providerDocId: 'provider_doc_1', status: 'connecting' },
    }));
    expect(provider.status?.()).toBe('connecting');

    provider.destroy();
    ydoc.destroy();
  });
});
