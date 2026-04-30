export interface WebConfig {
  apiUrl: string;
  websocketUrl: string;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, '');
}

export function readWebConfig(env: ImportMetaEnv = import.meta.env): WebConfig {
  return {
    apiUrl: trimTrailingSlash(env.VITE_MARKLAB_API_URL ?? 'http://127.0.0.1:3001'),
    websocketUrl: trimTrailingSlash(env.VITE_MARKLAB_WS_URL ?? 'ws://127.0.0.1:3001/collab'),
  };
}
