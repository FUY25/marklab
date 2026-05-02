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

export function readWebConfig(env: ImportMetaEnv = import.meta.env): WebConfig {
  const apiUrl = trimTrailingSlash(env.VITE_MARKLAB_API_URL ?? 'http://127.0.0.1:3001');
  const websocketUrl = normalizeWebsocketUrl(env.VITE_MARKLAB_WS_URL ?? 'ws://127.0.0.1:3001/collab');
  const relayWebSocketUrl = env.VITE_MARKLAB_RELAY_WS_URL
    ? normalizeRelayWebSocketUrl(env.VITE_MARKLAB_RELAY_WS_URL)
    : relayWebSocketUrlFromCollabUrl(websocketUrl);

  return {
    apiUrl,
    websocketUrl,
    relayWebSocketUrl,
  };
}
