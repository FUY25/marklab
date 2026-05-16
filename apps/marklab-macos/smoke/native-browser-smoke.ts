import http from 'node:http';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  createAwarenessUser,
  createCursorAwareness,
  resolveCursorAwareness,
} from '@marklab/collab-editor';
import { createYjsProvider, STATUS_CONNECTED, type YSweetProvider } from '@y-sweet/client';
import { type ClientToken } from '@y-sweet/sdk';
import { Awareness } from 'y-protocols/awareness';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import type { DbPool, DbQueryResult, DbTransactionClient } from '../../api/src/db/client';
import { createHttpApp, type HttpRequestAuth } from '../../api/src/http/app';
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
import { createHeadlessMilkdownRuntime } from '../../api/src/services/milkdown-headless-runtime';
import { createUnavailableLiveMarkdownWriter } from '../../api/src/services/live-writer';

const docId = 'doc_native_browser_smoke';
const branchId = 'branch_native_browser_smoke';
const providerDocId = 'ml_doc_native_browser_smoke';
const execFileAsync = promisify(execFile);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const originalWarn = console.warn.bind(console);

console.warn = (...args: unknown[]) => {
  if (String(args[0] ?? '') === 'connect() called while a connect loop is already running.') return;
  originalWarn(...args);
};

async function createYSweetAuthPair(): Promise<{ privateKey: string; serverToken: string }> {
  const result = await execFileAsync('pnpm', ['--filter', '@marklab/api', 'exec', 'y-sweet', 'gen-auth', '--json']);
  const body = JSON.parse(result.stdout) as { private_key?: string; server_token?: string };
  if (!body.private_key || !body.server_token) throw new Error('ysweet_gen_auth_failed');
  return { privateKey: body.private_key, serverToken: body.server_token };
}

async function runNativeRuntimeGate(): Promise<void> {
  await execFileAsync('swift', ['build', '--product', 'MarkLabApp'], { cwd: packageRoot });
  await execFileAsync('swift', ['test', '--filter', 'NativeCollaborationRuntimeTests'], { cwd: packageRoot });
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
    await delay(150);
  }
  throw new Error(`provider_ready_timeout:${lastError}`);
}

function createSmokePool(initialYjsState: Uint8Array): DbPool {
  const query: DbPool['query'] = async <Row = unknown>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<DbQueryResult<Row>> => {
    if (/insert into collab_sessions/u.test(sql)) {
      return { rows: [{ id: params?.[0] } as Row], rowCount: 1 };
    }
    if (/update collab_sessions/u.test(sql)) {
      return { rows: [], rowCount: 1 };
    }
    if (/insert into provider_token_issuances/u.test(sql)) {
      return { rows: [{ id: `issuance_${params?.[0] ?? 'smoke'}` } as Row], rowCount: 1 };
    }
    if (/select 1\s+from provider_token_issuances pending/u.test(sql)) {
      return { rows: [{ active: 1 } as Row], rowCount: 1 };
    }
    if (/pending\.status = 'pending'/u.test(sql)) {
      return { rows: [], rowCount: 1 };
    }
    if (/update document_branch_states[\s\S]+provider_doc_seeded_at = now/u.test(sql)) {
      return { rows: [], rowCount: 1 };
    }
    if (/update provider_token_issuances/u.test(sql)) {
      return { rows: [], rowCount: 1 };
    }
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
          version_id: 'version_smoke',
          version_number: 1,
          current_hash: 'sha256:smoke',
          current_markdown: '',
        } as Row],
        rowCount: 1,
      };
    }
    if (/^(begin|commit|rollback)$/iu.test(sql.trim())) return { rows: [], rowCount: 0 };
    if (/pg_advisory_xact_lock/u.test(sql)) return { rows: [{} as Row], rowCount: 1 };
    throw new Error(`unexpected_smoke_query:${sql}`);
  };

  return {
    query,
    async connect(): Promise<DbTransactionClient> {
      return {
        query,
        release: () => undefined,
      };
    },
  };
}

function createSmokeAuth(): HttpRequestAuth {
  return {
    async requireAdminAccess() {},
    async requireDocumentAccess(_req, _docId, _branchId, operation) {
      if (operation !== 'write') throw new Error('forbidden');
      return {
        actorType: 'user',
        actorId: 'smoke-user',
        role: 'edit',
      };
    },
  };
}

async function listen(server: http.Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

async function requestEditSession(apiPort: number, clientKind: 'app' | 'browser', displayName: string): Promise<ClientToken> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (clientKind === 'app') {
    headers.authorization = 'Bearer ml_user_smoke';
    headers['x-marklab-native-app'] = '1';
  }
  const response = await fetch(`http://127.0.0.1:${apiPort}/api/docs/${docId}/branches/${branchId}/collab/session`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ mode: 'edit', clientKind, displayName }),
  });
  if (!response.ok) {
    throw new Error(`collab_session_failed:${response.status}:${await response.text()}`);
  }
  const body = await response.json() as { session?: { clientKind?: string }; providerToken?: { clientToken?: ClientToken } };
  if (body.session?.clientKind !== clientKind) {
    throw new Error(`collab_session_wrong_client_kind:${clientKind}:${body.session?.clientKind ?? 'missing'}`);
  }
  if (!body.providerToken?.clientToken) throw new Error('collab_session_missing_client_token');
  return body.providerToken.clientToken;
}

async function waitForConnection(provider: YSweetProvider, timeoutMs = 5_000): Promise<void> {
  if (provider.status === STATUS_CONNECTED) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      provider.off('connection-status', onStatus);
      reject(new Error(`provider_connection_timeout:${provider.status}`));
    }, timeoutMs);
    function onStatus(status: string) {
      if (status !== STATUS_CONNECTED) return;
      clearTimeout(timer);
      provider.off('connection-status', onStatus);
      resolve();
    }
    provider.on('connection-status', onStatus);
  });
}

async function waitForNoLocalChanges(provider: YSweetProvider, timeoutMs = 5_000): Promise<void> {
  if (!provider.hasLocalChanges) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      provider.off('local-changes', onLocalChanges);
      reject(new Error('provider_local_changes_timeout'));
    }, timeoutMs);
    function onLocalChanges(hasLocalChanges: boolean) {
      if (hasLocalChanges) return;
      clearTimeout(timer);
      provider.off('local-changes', onLocalChanges);
      resolve();
    }
    provider.on('local-changes', onLocalChanges);
  });
}

function connectClient(doc: Y.Doc, awareness: Awareness, clientToken: ClientToken): YSweetProvider {
  return createYjsProvider(doc, clientToken.docId, async () => clientToken, {
    awareness,
    WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
    showDebuggerLink: false,
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(label: string, predicate: () => Promise<boolean> | boolean, timeoutMs = 5_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return;
    await delay(50);
  }
  throw new Error(`timeout:${label}`);
}

function projectHostedNativeWebViewToDisk(ytext: Y.Text, filePath: string): {
  stop(): Promise<void>;
  conflictDetected(): boolean;
} {
  let queued = Promise.resolve();
  let lastProjectedMarkdown = '';
  let detectedConflict = false;
  const writeCurrent = () => {
    const markdown = ytext.toString();
    queued = queued.then(async () => {
      const diskMarkdown = await readFile(filePath, 'utf8');
      if (diskMarkdown !== lastProjectedMarkdown && diskMarkdown !== markdown) {
        detectedConflict = true;
        return;
      }
      await writeFile(filePath, markdown, 'utf8');
      lastProjectedMarkdown = markdown;
    });
  };
  ytext.observe(writeCurrent);
  writeCurrent();
  return {
    async stop() {
      ytext.unobserve(writeCurrent);
      await queued;
    },
    conflictDetected() {
      return detectedConflict;
    },
  };
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'marklab-native-browser-smoke-'));
  const storePath = join(root, 'ysweet');
  const diskPath = join(root, 'native.md');
  await mkdir(storePath, { recursive: true });
  await writeFile(diskPath, '', 'utf8');
  const providerPort = await getFreePort();
  const apiPort = await getFreePort();
  const auth = await createYSweetAuthPair();
  const providerConfig = loadYSweetProviderProcessConfig({
    MARKLAB_YSWEET_PROVIDER_MODE: 'process',
    MARKLAB_YSWEET_SERVER_URL: `http://127.0.0.1:${providerPort}`,
    MARKLAB_YSWEET_PUBLIC_URL_PREFIX: `http://127.0.0.1:${apiPort}`,
    MARKLAB_YSWEET_STORE_PATH: storePath,
    MARKLAB_YSWEET_AUTH: auth.privateKey,
    MARKLAB_YSWEET_SERVER_TOKEN: auth.serverToken,
    MARKLAB_YSWEET_CHECKPOINT_FREQ_SECONDS: '1',
  }, { requireAuth: true, requireServerToken: true, requireStorePath: true });
  const connectionString = providerConfig.connectionString;
  if (!connectionString) throw new Error('smoke_connection_string_missing');
  const initialState = await createHeadlessMilkdownRuntime().initializeFromMarkdown('');
  const pool = createSmokePool(initialState.yjsState);
  let provider = startYSweetProviderProcess(providerConfig);
  const app = createHttpApp(pool, createUnavailableLiveMarkdownWriter(), {
    auth: createSmokeAuth(),
    providerTokenService: createYSweetTokenService({ connectionString }),
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
  const apiServer = http.createServer(app);
  apiServer.on('upgrade', (request, socket, head) => {
    if (!isYSweetProviderWebSocketPath(request.url)) {
      socket.destroy();
      return;
    }
    proxyYSweetProviderWebSocketUpgrade(provider.serverUrl, request, socket, head);
  });

  let nativeProvider: YSweetProvider | null = null;
  let browserProvider: YSweetProvider | null = null;
  let diskProjection: ReturnType<typeof projectHostedNativeWebViewToDisk> | null = null;

  try {
    await runNativeRuntimeGate();
    await waitForProviderReady(provider);
    await listen(apiServer, apiPort);

    const [nativeToken, browserToken] = await Promise.all([
      requestEditSession(apiPort, 'app', 'MarkLab.app'),
      requestEditSession(apiPort, 'browser', 'Browser guest'),
    ]);
    const nativeDoc = new Y.Doc();
    const browserDoc = new Y.Doc();
    const nativeAwareness = new Awareness(nativeDoc);
    const browserAwareness = new Awareness(browserDoc);
    nativeProvider = connectClient(nativeDoc, nativeAwareness, nativeToken);
    browserProvider = connectClient(browserDoc, browserAwareness, browserToken);
    await Promise.all([waitForConnection(nativeProvider), waitForConnection(browserProvider)]);

    const nativeText = nativeDoc.getText('contents');
    const browserText = browserDoc.getText('contents');
    diskProjection = projectHostedNativeWebViewToDisk(nativeText, diskPath);

    nativeText.insert(0, 'Native first\n');
    await waitForNoLocalChanges(nativeProvider);
    await waitUntil('browser sees native text', () => browserText.toString() === 'Native first\n');

    browserText.insert(browserText.length, 'Browser second\n');
    await waitForNoLocalChanges(browserProvider);
    await waitUntil('native sees browser text', () => nativeText.toString() === 'Native first\nBrowser second\n');
    await waitUntil('disk receives projected markdown', async () => (await readFile(diskPath, 'utf8')) === 'Native first\nBrowser second\n');

    const nativeUser = createAwarenessUser({ sessionId: 'session_native', displayName: 'MarkLab.app', kind: 'human' });
    const browserUser = createAwarenessUser({ sessionId: 'session_browser', displayName: 'Browser guest', kind: 'human' });
    nativeAwareness.setLocalState(createCursorAwareness(nativeText, { anchor: 0, head: 6 }, nativeUser));
    browserAwareness.setLocalState(createCursorAwareness(browserText, { anchor: 13, head: 20 }, browserUser));

    await waitUntil('browser sees native awareness', () => {
      for (const [clientId, state] of browserAwareness.getStates()) {
        if (clientId === browserDoc.clientID) continue;
        const resolved = resolveCursorAwareness(browserText, state);
        if (resolved?.user.id === 'session_native' && resolved.anchor === 0 && resolved.head === 6) return true;
      }
      return false;
    });
    await waitUntil('native sees browser awareness', () => {
      for (const [clientId, state] of nativeAwareness.getStates()) {
        if (clientId === nativeDoc.clientID) continue;
        const resolved = resolveCursorAwareness(nativeText, state);
        if (resolved?.user.id === 'session_browser' && resolved.anchor === 13 && resolved.head === 20) return true;
      }
      return false;
    });

    await writeFile(diskPath, 'Native first\nBrowser second\nLocal conflict\n', 'utf8');
    browserText.insert(browserText.length, 'Remote conflict\n');
    await waitForNoLocalChanges(browserProvider);
    await waitUntil('native projection detects local/shared conflict', () => diskProjection?.conflictDetected() === true);
    const diskAfterConflict = await readFile(diskPath, 'utf8');
    if (diskAfterConflict !== 'Native first\nBrowser second\nLocal conflict\n') {
      throw new Error(`native_conflict_overwrote_disk:${JSON.stringify(diskAfterConflict)}`);
    }

    console.log(JSON.stringify({
      ok: true,
      providerDocId,
      nativeText: nativeText.toString(),
      diskMarkdown: await readFile(diskPath, 'utf8'),
      nativeRuntimeGate: true,
      nativeAppBuildGate: true,
      nativeProjectionHelperGate: true,
      nativeConflictGate: true,
      nativeSawBrowserCursor: true,
      browserSawNativeCursor: true,
    }));
  } finally {
    if (diskProjection) await diskProjection.stop().catch(() => undefined);
    nativeProvider?.disconnect();
    browserProvider?.disconnect();
    nativeProvider?.destroy();
    browserProvider?.destroy();
    await closeServer(apiServer).catch(() => undefined);
    await stopYSweetProviderProcess(provider).catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

void main()
  .then(() => {
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
