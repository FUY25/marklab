import http, { type IncomingMessage, type RequestOptions, type ServerResponse } from 'node:http';
import https from 'node:https';
import type { Duplex } from 'node:stream';

export function isYSweetProviderWebSocketPath(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const pathname = new URL(value, 'http://marklab.local').pathname;
    if (pathname === '/doc/ws' || pathname.startsWith('/doc/ws/')) return true;
    return /^\/d\/[^/]+\/ws(?:\/[^/]+)?\/?$/u.test(pathname);
  } catch {
    return false;
  }
}

export function isYSweetProviderHttpPath(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const pathname = new URL(value, 'http://marklab.local').pathname;
    return /^\/d\/[^/]+\/(?:as-update|update)\/?$/u.test(pathname)
      || /^\/doc\/[^/]+\/(?:as-update|update)\/?$/u.test(pathname);
  } catch {
    return false;
  }
}

export function buildYSweetProviderWebSocketTarget(serverUrl: string, requestUrl: string | undefined): URL {
  const base = new URL(serverUrl);
  const incoming = new URL(requestUrl ?? '/', base.origin);
  const basePath = base.pathname.replace(/\/$/u, '');
  const pathname = basePath && basePath !== '/'
    ? `${basePath}${incoming.pathname}`
    : incoming.pathname;
  return new URL(`${pathname}${incoming.search}`, base.origin);
}

export function isYSweetProviderWebSocketOriginAllowed(input: {
  origin: string | string[] | undefined;
  allowedOrigins: readonly string[];
  enforceAllowedOrigins: boolean;
}): boolean {
  if (!input.enforceAllowedOrigins) return true;
  const origin = Array.isArray(input.origin) ? input.origin[0] : input.origin;
  if (!origin) return true;
  try {
    return input.allowedOrigins.includes(new URL(origin).origin);
  } catch {
    return false;
  }
}

export function proxyYSweetProviderWebSocketUpgrade(
  providerServerUrl: string,
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): void {
  const target = buildYSweetProviderWebSocketTarget(providerServerUrl, request.url);
  const requestOptions: RequestOptions = {
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port,
    method: request.method,
    path: `${target.pathname}${target.search}`,
    headers: {
      ...request.headers,
      host: target.host,
    },
  };
  const requestModule = target.protocol === 'https:' ? https : http;
  const upstreamRequest = requestModule.request(requestOptions);

  upstreamRequest.on('upgrade', (upstreamResponse, upstreamSocket, upstreamHead) => {
    const statusCode = upstreamResponse.statusCode ?? 101;
    const statusMessage = upstreamResponse.statusMessage ?? 'Switching Protocols';
    const responseLines = [`HTTP/1.1 ${statusCode} ${statusMessage}`];
    for (const [name, value] of Object.entries(upstreamResponse.headers)) {
      if (Array.isArray(value)) {
        for (const item of value) responseLines.push(`${name}: ${item}`);
      } else if (value !== undefined) {
        responseLines.push(`${name}: ${value}`);
      }
    }
    socket.write(`${responseLines.join('\r\n')}\r\n\r\n`);
    if (upstreamHead.length > 0) socket.write(upstreamHead);
    if (head.length > 0) upstreamSocket.write(head);
    upstreamSocket.on('error', () => {
      socket.destroy();
    });
    upstreamSocket.on('close', () => {
      socket.destroy();
    });
    socket.on('error', () => {
      upstreamSocket.destroy();
    });
    socket.on('close', () => {
      upstreamSocket.destroy();
    });
    upstreamSocket.pipe(socket);
    socket.pipe(upstreamSocket);
  });

  upstreamRequest.on('response', (response) => {
    const statusCode = response.statusCode ?? 502;
    const statusMessage = response.statusMessage ?? 'Bad Gateway';
    response.resume();
    socket.write(`HTTP/1.1 ${statusCode} ${statusMessage}\r\n\r\n`);
    socket.destroy();
  });

  upstreamRequest.on('error', () => {
    socket.destroy();
  });

  socket.on('error', () => {
    upstreamRequest.destroy();
  });
  socket.on('close', () => {
    upstreamRequest.destroy();
  });

  upstreamRequest.end();
}

export function proxyYSweetProviderHttpRequest(
  providerServerUrl: string,
  request: IncomingMessage,
  response: ServerResponse,
): void {
  const target = buildYSweetProviderWebSocketTarget(providerServerUrl, request.url);
  const requestOptions: RequestOptions = {
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port,
    method: request.method,
    path: `${target.pathname}${target.search}`,
    headers: {
      ...request.headers,
      host: target.host,
    },
  };
  const requestModule = target.protocol === 'https:' ? https : http;
  const upstreamRequest = requestModule.request(requestOptions, (upstreamResponse) => {
    response.writeHead(
      upstreamResponse.statusCode ?? 502,
      upstreamResponse.statusMessage ?? 'Bad Gateway',
      upstreamResponse.headers,
    );
    upstreamResponse.pipe(response);
  });

  upstreamRequest.on('error', () => {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    response.writeHead(502, 'Bad Gateway');
    response.end('provider_proxy_failed');
  });

  request.on('error', () => {
    upstreamRequest.destroy();
  });

  request.pipe(upstreamRequest);
}
