// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import type { ProviderClientToken } from '../api/collab-session';
import { createMarkLabYjsProvider, type MarkLabYjsProviderOptions } from './yjs-provider';

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

function flushAsyncConnectLoop(): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, 0);
  });
}

describe('MarkLab real Y-Sweet provider lifecycle wrapper', () => {
  it('does not construct a websocket or reject when destroyed during the initial async connect loop', async () => {
    const createdUrls: string[] = [];
    class TestWebSocket extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readonly url: string;
      readyState = TestWebSocket.CONNECTING;
      binaryType: BinaryType = 'arraybuffer';
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;

      constructor(url: string | URL) {
        super();
        this.url = String(url);
        createdUrls.push(this.url);
      }

      send(): void {
        // No-op test transport.
      }

      close(): void {
        this.readyState = TestWebSocket.CLOSED;
      }
    }

    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    const processEvents = (globalThis as unknown as {
      process?: {
        on(eventName: 'unhandledRejection', handler: (reason: unknown) => void): void;
        off(eventName: 'unhandledRejection', handler: (reason: unknown) => void): void;
      };
    }).process;
    processEvents?.on('unhandledRejection', onUnhandledRejection);
    try {
      const ydoc = new Y.Doc();
      const providerOptions = {
        awareness: new Awareness(ydoc),
        initialClientToken: clientToken(),
        connect: true,
        offlineSupport: false,
        showDebuggerLink: false,
        WebSocketPolyfill: TestWebSocket as unknown as typeof WebSocket,
      } satisfies MarkLabYjsProviderOptions & { WebSocketPolyfill: typeof WebSocket };
      const provider = createMarkLabYjsProvider(
        ydoc,
        'provider_doc_1',
        async () => clientToken(),
        providerOptions,
      );

      provider.destroy();
      await flushAsyncConnectLoop();

      expect(createdUrls).toEqual([]);
      expect(unhandledRejections).toEqual([]);
      ydoc.destroy();
    } finally {
      processEvents?.off('unhandledRejection', onUnhandledRejection);
    }
  });
});
