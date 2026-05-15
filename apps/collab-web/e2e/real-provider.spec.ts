import { execFile } from 'node:child_process';
import http from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, test, type BrowserContext, type Route } from '@playwright/test';
import type { DbPool, DbQueryResult, DbTransactionClient } from '../../api/src/db/client';
import { createHttpApp, type HttpRequestAuth } from '../../api/src/http/app';
import { createHeadlessMilkdownRuntime } from '../../api/src/services/milkdown-headless-runtime';
import { createUnavailableLiveMarkdownWriter } from '../../api/src/services/live-writer';
import { createYSweetTokenService } from '../../api/src/provider/ysweet-token-service';
import {
  loadYSweetProviderProcessConfig,
  readYSweetProviderHealth,
  startYSweetProviderProcess,
  stopYSweetProviderProcess,
  type YSweetProviderHandle,
} from '../../api/src/provider/ysweet-provider-process';
import {
  isYSweetProviderHttpPath,
  isYSweetProviderWebSocketPath,
  proxyYSweetProviderHttpRequest,
  proxyYSweetProviderWebSocketUpgrade,
} from '../../api/src/provider/ysweet-provider-websocket-proxy';

const docId = 'doc_real_provider_e2e';
const branchId = 'branch_real_provider_e2e';
const providerDocId = 'ml_doc_real_provider_e2e';
const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

async function createYSweetAuthPair(): Promise<{ privateKey: string; serverToken: string }> {
  const result = await execFileAsync(
    'npx',
    ['-y', 'pnpm@10.0.0', '--filter', '@marklab/api', 'exec', 'y-sweet', 'gen-auth', '--json'],
    { cwd: repoRoot },
  );
  const body = JSON.parse(result.stdout) as { private_key?: string; server_token?: string };
  if (!body.private_key || !body.server_token) throw new Error('ysweet_gen_auth_failed');
  return { privateKey: body.private_key, serverToken: body.server_token };
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('free_port_unavailable')));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForProviderReady(handle: YSweetProviderHandle, timeoutMs = 10_000): Promise<void> {
  const startedAt = Date.now();
  let lastError = 'provider_not_ready';
  while (Date.now() - startedAt < timeoutMs) {
    const health = await readYSweetProviderHealth(handle);
    if (health.ready && health.storeReady) return;
    lastError = health.error ?? lastError;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`provider_ready_timeout:${lastError}`);
}

function createBrowserSmokePool(initialYjsState: Uint8Array): DbPool {
  const query: DbPool['query'] = async <Row = unknown>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<DbQueryResult<Row>> => {
    if (/insert into collab_sessions/u.test(sql)) {
      return { rows: [{ id: params?.[0] } as Row], rowCount: 1 };
    }
    if (/update collab_sessions/u.test(sql)) return { rows: [], rowCount: 1 };
    if (/insert into provider_token_issuances/u.test(sql)) {
      return { rows: [{ id: 'issuance_browser_e2e' } as Row], rowCount: 1 };
    }
    if (/select 1\s+from provider_token_issuances pending/u.test(sql)) {
      return { rows: [{ active: 1 } as Row], rowCount: 1 };
    }
    if (/pending\.status = 'pending'/u.test(sql)) return { rows: [], rowCount: 1 };
    if (/update document_branch_states[\s\S]+provider_doc_seeded_at = now/u.test(sql)) {
      return { rows: [], rowCount: 1 };
    }
    if (/update provider_token_issuances/u.test(sql)) return { rows: [], rowCount: 1 };
    if (/select s\.provider_doc_seeded_at/u.test(sql)) {
      return {
        rows: [{
          provider_doc_seeded_at: null,
          yjs_state: Buffer.from(initialYjsState),
        } as Row],
        rowCount: 1,
      };
    }
    if (/select s\.provider_doc_id/u.test(sql)) {
      return {
        rows: [{
          provider_doc_id: providerDocId,
          provider_doc_seeded_at: null,
          yjs_state: Buffer.from(initialYjsState),
        } as Row],
        rowCount: 1,
      };
    }
    if (/from documents d/u.test(sql)) {
      return {
        rows: [{
          doc_id: params?.[0],
          branch_id: params?.[1],
          version_id: 'version_browser_e2e',
          version_number: 1,
          current_hash: 'sha256:browser-e2e',
          current_markdown: '',
        } as Row],
        rowCount: 1,
      };
    }
    if (/^(begin|commit|rollback)$/iu.test(sql.trim())) return { rows: [], rowCount: 0 };
    if (/pg_advisory_xact_lock/u.test(sql)) return { rows: [{} as Row], rowCount: 1 };
    throw new Error(`unexpected_browser_smoke_query:${sql}`);
  };

  return {
    query,
    async connect(): Promise<DbTransactionClient> {
      return { query, release: () => undefined };
    },
  };
}

function createBrowserSmokeAuth(): HttpRequestAuth {
  return {
    async requireAdminAccess() {},
    async requireDocumentAccess(_req, _docId, _branchId, operation) {
      if (operation !== 'write') throw new Error('forbidden');
      return { actorType: 'user', actorId: 'browser-smoke-user', role: 'edit' };
    },
  };
}

async function listen(server: http.Server, port: number): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('listen_address_unavailable'));
        return;
      }
      resolve(address.port);
    });
  });
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

async function createRealProviderHarness(): Promise<{
  apiBaseUrl: string;
  providerBaseUrl: string;
  close(): Promise<void>;
}> {
  let root: string | null = null;
  let provider: YSweetProviderHandle | null = null;
  let apiServer: http.Server | null = null;
  try {
    root = await mkdtemp(join(tmpdir(), 'marklab-collab-web-provider-'));
    const storePath = join(root, 'ysweet');
    await mkdir(storePath, { recursive: true });
    apiServer = http.createServer((_request, response) => {
      response.statusCode = 503;
      response.end('api_starting');
    });
    const apiPort = await listen(apiServer, 0);
    const providerPort = await getFreePort();
    const auth = await createYSweetAuthPair();
    const providerConfig = loadYSweetProviderProcessConfig({
      MARKLAB_YSWEET_PROVIDER_MODE: 'process',
      MARKLAB_YSWEET_SERVER_URL: `http://127.0.0.1:${providerPort}`,
      MARKLAB_YSWEET_PUBLIC_URL_PREFIX: `http://127.0.0.1:${apiPort}`,
      MARKLAB_YSWEET_STORE_PATH: storePath,
      MARKLAB_YSWEET_AUTH: auth.privateKey,
      MARKLAB_YSWEET_SERVER_TOKEN: auth.serverToken,
      MARKLAB_YSWEET_CHECKPOINT_FREQ_SECONDS: '1',
    }, { cwd: repoRoot, requireAuth: true, requireServerToken: true, requireStorePath: true });
    if (!providerConfig.connectionString) throw new Error('browser_smoke_connection_string_missing');
    provider = startYSweetProviderProcess(providerConfig);
    const initialState = await createHeadlessMilkdownRuntime().initializeFromMarkdown('');
    const app = createHttpApp(createBrowserSmokePool(initialState.yjsState), createUnavailableLiveMarkdownWriter(), {
      auth: createBrowserSmokeAuth(),
      providerTokenService: createYSweetTokenService({ connectionString: providerConfig.connectionString }),
      providerHttpProxy: (request, response, next) => {
        if (!isYSweetProviderHttpPath(request.originalUrl ?? request.url)) {
          next();
          return;
        }
        proxyYSweetProviderHttpRequest(provider.serverUrl, request, response);
      },
      health: {
        providerRequired: true,
        providerHealth: () => readYSweetProviderHealth(provider),
      },
    });
    apiServer.removeAllListeners('request');
    apiServer.on('request', app);
    apiServer.on('upgrade', (request, socket, head) => {
      if (!isYSweetProviderWebSocketPath(request.url)) {
        socket.destroy();
        return;
      }
      proxyYSweetProviderWebSocketUpgrade(provider.serverUrl, request, socket, head);
    });
    await waitForProviderReady(provider);

    return {
      apiBaseUrl: `http://127.0.0.1:${apiPort}`,
      providerBaseUrl: provider.serverUrl,
      async close() {
        if (apiServer) await closeServer(apiServer).catch(() => undefined);
        if (provider) await stopYSweetProviderProcess(provider).catch(() => undefined);
        if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined);
      },
    };
  } catch (error) {
    if (apiServer) await closeServer(apiServer).catch(() => undefined);
    if (provider) await stopYSweetProviderProcess(provider).catch(() => undefined);
    if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function proxyControlPlaneToApi(context: BrowserContext, apiBaseUrl: string): Promise<void> {
  await context.route(`**/api/docs/${docId}/branches/${branchId}/collab/session**`, async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const response = await fetch(`${apiBaseUrl}${url.pathname}${url.search}`, {
      method: request.method(),
      headers: { 'content-type': request.headers()['content-type'] ?? 'application/json' },
      body: request.postData() ?? undefined,
    });
    await route.fulfill({
      status: response.status,
      contentType: response.headers.get('content-type') ?? 'application/json',
      body: await response.text(),
    });
  });
}

function editUrl() {
  return `/?mode=edit&docId=${docId}&branchId=${branchId}&token=real_provider_edit_token`;
}

test('edit tabs sync through the real API-root Y-Sweet websocket provider', async ({ browser }) => {
  test.setTimeout(90_000);
  let harness: Awaited<ReturnType<typeof createRealProviderHarness>> | null = null;
  let context: BrowserContext | null = null;
  const websocketUrls: string[] = [];
  try {
    harness = await createRealProviderHarness();
    context = await browser.newContext();
    await proxyControlPlaneToApi(context, harness.apiBaseUrl);
    const pageA = await context.newPage();
    const pageB = await context.newPage();
    pageA.on('websocket', (socket) => websocketUrls.push(socket.url()));
    pageB.on('websocket', (socket) => websocketUrls.push(socket.url()));

    await Promise.all([pageA.goto(editUrl()), pageB.goto(editUrl())]);
    await pageA.locator('.cm-content').click();
    await pageA.keyboard.type('real provider browser sync');

    await expect(pageB.locator('.cm-content')).toContainText('real provider browser sync', { timeout: 10_000 });
    const apiHost = new URL(harness.apiBaseUrl).host;
    const providerHost = new URL(harness.providerBaseUrl).host;
    const providerWebsockets = websocketUrls
      .map((url) => new URL(url))
      .filter((url) => url.pathname === `/d/${providerDocId}/ws/${providerDocId}`);
    expect(providerWebsockets.some((url) => url.host === apiHost && url.searchParams.has('token'))).toBe(true);
    expect(websocketUrls.map((url) => new URL(url)).every((url) => url.host !== providerHost)).toBe(true);
  } finally {
    await context?.close().catch(() => undefined);
    await harness?.close();
  }
});
