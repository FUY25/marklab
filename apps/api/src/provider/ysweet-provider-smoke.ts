import http from 'node:http';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { promisify } from 'node:util';
import { createYjsProvider, STATUS_CONNECTED, type YSweetProvider } from '@y-sweet/client';
import { DocConnection, type ClientToken } from '@y-sweet/sdk';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import type { DbPool, DbQueryResult, DbTransactionClient } from '../db/client';
import { createHttpApp, type HttpRequestAuth } from '../http/app';
import { createHeadlessMilkdownRuntime } from '../services/milkdown-headless-runtime';
import { createUnavailableLiveMarkdownWriter } from '../services/live-writer';
import { createYSweetTokenService } from './ysweet-token-service';
import {
  loadYSweetProviderProcessConfig,
  readYSweetProviderHealth,
  startYSweetProviderProcess,
  stopYSweetProviderProcess,
  type YSweetProviderHandle,
} from './ysweet-provider-process';
import {
  isYSweetProviderHttpPath,
  isYSweetProviderWebSocketPath,
  proxyYSweetProviderHttpRequest,
  proxyYSweetProviderWebSocketUpgrade,
} from './ysweet-provider-websocket-proxy';

const docId = 'doc_smoke';
const branchId = 'branch_smoke';
const providerDocId = 'ml_doc_smoke';
const execFileAsync = promisify(execFile);

async function createYSweetAuthPair(): Promise<{ privateKey: string; serverToken: string }> {
  const result = await execFileAsync('pnpm', ['--filter', '@marklab/api', 'exec', 'y-sweet', 'gen-auth', '--json']);
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
      return { rows: [{ id: 'issuance_smoke' } as Row], rowCount: 1 };
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

async function requestEditSession(apiPort: number): Promise<ClientToken> {
  const response = await fetch(`http://127.0.0.1:${apiPort}/api/docs/${docId}/branches/${branchId}/collab/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'edit', clientKind: 'browser', displayName: 'Smoke' }),
  });
  if (!response.ok) {
    throw new Error(`collab_session_failed:${response.status}:${await response.text()}`);
  }
  const body = await response.json() as { providerToken?: { clientToken?: ClientToken } };
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

function connectClient(doc: Y.Doc, clientToken: ClientToken): YSweetProvider {
  return createYjsProvider(doc, clientToken.docId, async () => clientToken, {
    WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
    showDebuggerLink: false,
  });
}

async function countStoreFiles(storePath: string): Promise<{ files: number; bytes: number }> {
  async function walk(path: string): Promise<{ files: number; bytes: number }> {
    const entries = await readdir(path, { withFileTypes: true });
    let files = 0;
    let bytes = 0;
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) {
        const childCount = await walk(child);
        files += childCount.files;
        bytes += childCount.bytes;
      } else if (entry.isFile()) {
        files += 1;
        bytes += (await stat(child)).size;
      }
    }
    return { files, bytes };
  }
  return await walk(storePath);
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'marklab-ysweet-smoke-'));
  const storePath = join(root, 'ysweet');
  await mkdir(storePath, { recursive: true });
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
  let provider = startYSweetProviderProcess(providerConfig);
  const initialState = await createHeadlessMilkdownRuntime().initializeFromMarkdown('');
  const pool = createSmokePool(initialState.yjsState);
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

  try {
    await waitForProviderReady(provider);
    await listen(apiServer, apiPort);
    const clientToken = await requestEditSession(apiPort);
    const writeDoc = new Y.Doc();
    const writeProvider = connectClient(writeDoc, clientToken);
    await waitForConnection(writeProvider);
    const text = writeDoc.getText('contents');
    text.insert(0, 'contents');
    for (let index = 0; index < 200; index += 1) {
      text.insert(text.length, `\nline ${index + 1}`);
    }
    await waitForNoLocalChanges(writeProvider);
    writeProvider.destroy();
    await stopYSweetProviderProcess(provider);

    provider = startYSweetProviderProcess(providerConfig);
    await waitForProviderReady(provider);
    const publicConnection = new DocConnection(clientToken);
    const update = await publicConnection.getAsUpdate();
    const readDoc = new Y.Doc();
    Y.applyUpdate(readDoc, update);
    const restored = readDoc.getText('contents').toString();
    if (!restored.startsWith('contents\nline 1') || !restored.endsWith('line 200')) {
      throw new Error('provider_restart_content_mismatch');
    }
    const httpUpdateDoc = new Y.Doc();
    Y.applyUpdate(httpUpdateDoc, update);
    httpUpdateDoc.getText('contents').insert(httpUpdateDoc.getText('contents').length, '\nvia http proxy');
    await publicConnection.updateDoc(Y.encodeStateAsUpdate(httpUpdateDoc));
    const httpUpdate = await publicConnection.getAsUpdate();
    const httpReadDoc = new Y.Doc();
    Y.applyUpdate(httpReadDoc, httpUpdate);
    const restoredAfterHttpUpdate = httpReadDoc.getText('contents').toString();
    if (!restoredAfterHttpUpdate.endsWith('line 200\nvia http proxy')) {
      throw new Error('provider_http_proxy_content_mismatch');
    }
    const storeStats = await countStoreFiles(storePath);
    if (storeStats.files !== 1) {
      throw new Error(`provider_store_expected_single_checkpoint_file:${storeStats.files}`);
    }
    console.log(JSON.stringify({
      ok: true,
      providerDocId,
      linesWritten: 200,
      restoredBytes: restoredAfterHttpUpdate.length,
      storeFiles: storeStats.files,
      storeBytes: storeStats.bytes,
    }));
  } finally {
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
