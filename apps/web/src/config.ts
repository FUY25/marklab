export interface WebConfig {
  apiUrl: string;
  websocketUrl: string;
  relayWebSocketUrl: string;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, '');
}

function normalizeWebsocketUrl(value: string): string {
  const trimmed = trimTrailingSlash(value);

  try {
    const url = new URL(trimmed);
    if (!url.pathname || url.pathname === '/') {
      url.pathname = '/collab';
      return trimTrailingSlash(url.toString());
    }

    if (url.pathname.endsWith('/collab')) return trimmed;

    url.pathname = `${trimTrailingSlash(url.pathname)}/collab`;
    return trimTrailingSlash(url.toString());
  } catch {
    return trimmed.endsWith('/collab') ? trimmed : `${trimmed}/collab`;
  }
}

function normalizeRelayWebSocketUrl(value: string): string {
  const trimmed = trimTrailingSlash(value);

  try {
    const url = new URL(trimmed);
    if (!url.pathname || url.pathname === '/') {
      url.pathname = '/relay';
      return trimTrailingSlash(url.toString());
    }

    if (url.pathname.endsWith('/relay')) return trimmed;

    url.pathname = `${trimTrailingSlash(url.pathname)}/relay`;
    return trimTrailingSlash(url.toString());
  } catch {
    return trimmed.endsWith('/relay') ? trimmed : `${trimmed}/relay`;
  }
}

function relayWebSocketUrlFromCollabUrl(collabUrl: string): string {
  if (/\/collab$/u.test(collabUrl)) return collabUrl.replace(/\/collab$/u, '/relay');
  return normalizeRelayWebSocketUrl(collabUrl);
}

function sameOriginHttpUrl(): string | null {
  if (typeof window === 'undefined') return null;
  return window.location.origin;
}

function sameOriginWebSocketUrl(path: '/collab' | '/relay'): string | null {
  if (typeof window === 'undefined') return null;
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}${path}`;
}

export function readWebConfig(env: ImportMetaEnv = import.meta.env): WebConfig {
  const productionSameOrigin = !env.DEV;
  const apiUrl = trimTrailingSlash(
    env.VITE_MARKLAB_API_URL ?? (productionSameOrigin ? sameOriginHttpUrl() : null) ?? 'http://127.0.0.1:3001',
  );
  const websocketUrl = normalizeWebsocketUrl(
    env.VITE_MARKLAB_WS_URL ?? (productionSameOrigin ? sameOriginWebSocketUrl('/collab') : null) ?? 'ws://127.0.0.1:3001/collab',
  );
  const relayWebSocketUrl = env.VITE_MARKLAB_RELAY_WS_URL
    ? normalizeRelayWebSocketUrl(env.VITE_MARKLAB_RELAY_WS_URL)
    : productionSameOrigin
      ? sameOriginWebSocketUrl('/relay') ?? relayWebSocketUrlFromCollabUrl(websocketUrl)
      : relayWebSocketUrlFromCollabUrl(websocketUrl);

  return {
    apiUrl,
    websocketUrl,
    relayWebSocketUrl,
  };
}
