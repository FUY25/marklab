function trimTrailingSlash(value) {
  return value.replace(/\/+$/u, '');
}

function parseUrl(value, name) {
  try {
    return new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
}

function isLoopbackHostname(hostname) {
  const normalized = hostname.toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1' || normalized === '[::1]';
}

function normalizeHttpUrl(value, name) {
  const url = parseUrl(value, name);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`${name} must start with http:// or https://`);
  url.hash = '';
  return trimTrailingSlash(url.toString());
}

function normalizeRelayWsUrl(value, name) {
  const url = parseUrl(value, name);
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new Error(`${name} must start with ws:// or wss://`);
  url.hash = '';
  return trimTrailingSlash(url.toString());
}

function assertPublicUrl(value, name, { requireSecureRelay = false } = {}) {
  const url = parseUrl(value, name);
  if (isLoopbackHostname(url.hostname)) throw new Error(`${name} must not use localhost or loopback in public relay mode`);
  if (requireSecureRelay && url.protocol !== 'wss:') throw new Error(`${name} must start with wss:// in public relay mode`);
}

export function loadRelayConfig(input = {}) {
  const env = input.env ?? process.env;
  const apiPort = input.apiPort;
  const webPort = input.webPort;
  const configured = {
    publicWebUrl: env.MARKLAB_PUBLIC_WEB_URL,
    publicApiUrl: env.MARKLAB_PUBLIC_API_URL,
    publicRelayWebSocketUrl: env.MARKLAB_PUBLIC_RELAY_WS_URL,
  };
  const configuredCount = Object.values(configured).filter((value) => value && value.trim()).length;
  const publicMode = configuredCount > 0 || env.MARKLAB_RELAY_MODE === 'production';

  if (publicMode) {
    const envNames = {
      publicWebUrl: 'MARKLAB_PUBLIC_WEB_URL',
      publicApiUrl: 'MARKLAB_PUBLIC_API_URL',
      publicRelayWebSocketUrl: 'MARKLAB_PUBLIC_RELAY_WS_URL',
    };
    for (const [key, value] of Object.entries(configured)) {
      if (!value?.trim()) throw new Error(`${envNames[key]} is required when public relay URLs are configured`);
    }
    const publicWebUrl = normalizeHttpUrl(configured.publicWebUrl, 'MARKLAB_PUBLIC_WEB_URL');
    const publicApiUrl = normalizeHttpUrl(configured.publicApiUrl, 'MARKLAB_PUBLIC_API_URL');
    const publicRelayWebSocketUrl = normalizeRelayWsUrl(configured.publicRelayWebSocketUrl, 'MARKLAB_PUBLIC_RELAY_WS_URL');
    assertPublicUrl(publicWebUrl, 'MARKLAB_PUBLIC_WEB_URL');
    assertPublicUrl(publicApiUrl, 'MARKLAB_PUBLIC_API_URL');
    assertPublicUrl(publicRelayWebSocketUrl, 'MARKLAB_PUBLIC_RELAY_WS_URL', { requireSecureRelay: true });
    return {
      mode: 'production',
      publicWebUrl,
      publicApiUrl,
      publicRelayWebSocketUrl,
      relayWebSocketUrl: env.MARKLAB_RELAY_WS_URL ?? publicRelayWebSocketUrl,
    };
  }

  if (!Number.isInteger(apiPort) || apiPort <= 0) throw new Error('apiPort must be a positive integer');
  if (!Number.isInteger(webPort) || webPort <= 0) throw new Error('webPort must be a positive integer');
  const publicApiUrl = `http://127.0.0.1:${apiPort}`;
  const publicWebUrl = `http://127.0.0.1:${webPort}`;
  const publicRelayWebSocketUrl = `ws://127.0.0.1:${apiPort}/relay`;
  return {
    mode: 'development',
    publicWebUrl,
    publicApiUrl,
    publicRelayWebSocketUrl,
    relayWebSocketUrl: env.MARKLAB_RELAY_WS_URL ?? publicRelayWebSocketUrl,
  };
}

export function buildRelayJoinUrls(link) {
  let url;
  try {
    url = new URL(link);
  } catch {
    throw new Error('join requires a valid relay edit link');
  }
  const apiUrl = url.searchParams.get('apiUrl') ?? `${url.protocol}//${url.host}`;
  const wsUrl = url.searchParams.get('wsUrl') ?? apiUrl.replace(/^http/u, 'ws').replace(/\/$/u, '') + '/relay';
  return {
    apiUrl: trimTrailingSlash(apiUrl),
    wsUrl: trimTrailingSlash(wsUrl),
  };
}
