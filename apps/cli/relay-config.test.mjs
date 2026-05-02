import { describe, expect, it } from 'vitest';
import { buildRelayJoinUrls, loadRelayConfig } from './relay-config.mjs';

describe('loadRelayConfig', () => {
  it('builds loopback development URLs from local daemon ports', () => {
    expect(loadRelayConfig({ apiPort: 3011, webPort: 5175, env: {} })).toEqual({
      mode: 'development',
      publicWebUrl: 'http://127.0.0.1:5175',
      publicApiUrl: 'http://127.0.0.1:3011',
      publicRelayWebSocketUrl: 'ws://127.0.0.1:3011/relay',
      relayWebSocketUrl: 'ws://127.0.0.1:3011/relay',
    });
  });

  it('uses production public URLs only when all three are configured', () => {
    expect(loadRelayConfig({
      env: {
        MARKLAB_PUBLIC_WEB_URL: 'https://marklab-relay-alpha.fly.dev/',
        MARKLAB_PUBLIC_API_URL: 'https://marklab-relay-alpha.fly.dev/',
        MARKLAB_PUBLIC_RELAY_WS_URL: 'wss://marklab-relay-alpha.fly.dev/relay',
      },
    })).toEqual({
      mode: 'production',
      publicWebUrl: 'https://marklab-relay-alpha.fly.dev',
      publicApiUrl: 'https://marklab-relay-alpha.fly.dev',
      publicRelayWebSocketUrl: 'wss://marklab-relay-alpha.fly.dev/relay',
      relayWebSocketUrl: 'wss://marklab-relay-alpha.fly.dev/relay',
    });
  });

  it('rejects partial public URL configuration to avoid mixed local and hosted links', () => {
    expect(() => loadRelayConfig({
      apiPort: 3011,
      webPort: 5175,
      env: {
        MARKLAB_PUBLIC_WEB_URL: 'https://marklab.example.com',
      },
    })).toThrow('MARKLAB_PUBLIC_API_URL');
  });

  it('rejects loopback and insecure production relay URLs', () => {
    expect(() => loadRelayConfig({
      env: {
        MARKLAB_PUBLIC_WEB_URL: 'https://marklab.example.com',
        MARKLAB_PUBLIC_API_URL: 'http://127.0.0.1:3011',
        MARKLAB_PUBLIC_RELAY_WS_URL: 'wss://marklab.example.com/relay',
      },
    })).toThrow('MARKLAB_PUBLIC_API_URL');

    expect(() => loadRelayConfig({
      env: {
        MARKLAB_PUBLIC_WEB_URL: 'https://marklab.example.com',
        MARKLAB_PUBLIC_API_URL: 'https://marklab.example.com',
        MARKLAB_PUBLIC_RELAY_WS_URL: 'ws://marklab.example.com/relay',
      },
    })).toThrow('wss://');
  });
});

describe('buildRelayJoinUrls', () => {
  it('reads explicit public API and websocket URLs from relay links', () => {
    const urls = buildRelayJoinUrls(
      'https://marklab.example.com/relay/room_1?token=secret&apiUrl=https%3A%2F%2Fapi.example.com&wsUrl=wss%3A%2F%2Frelay.example.com%2Frelay',
    );
    expect(urls).toEqual({
      apiUrl: 'https://api.example.com',
      wsUrl: 'wss://relay.example.com/relay',
    });
  });

  it('defaults join API and websocket URLs to the relay link origin', () => {
    expect(buildRelayJoinUrls('https://marklab.example.com/relay/room_1?token=secret')).toEqual({
      apiUrl: 'https://marklab.example.com',
      wsUrl: 'wss://marklab.example.com/relay',
    });
  });
});
