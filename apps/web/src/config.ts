export interface WebConfig {
  apiUrl: string;
  websocketUrl: string;
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

export function readWebConfig(env: ImportMetaEnv = import.meta.env): WebConfig {
  return {
    apiUrl: trimTrailingSlash(env.VITE_MARKLAB_API_URL ?? 'http://127.0.0.1:3001'),
    websocketUrl: normalizeWebsocketUrl(env.VITE_MARKLAB_WS_URL ?? 'ws://127.0.0.1:3001/collab'),
  };
}
