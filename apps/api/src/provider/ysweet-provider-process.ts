import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export type YSweetProviderMode = 'disabled' | 'external' | 'process';

export interface YSweetProviderProcessConfig {
  mode: YSweetProviderMode;
  serverUrl: string;
  connectionString?: string;
  publicUrlPrefix: string;
  storePath?: string;
  auth?: string;
  serverToken?: string;
  host: string;
  port: number;
  checkpointFrequencySeconds: number;
  skipGc: boolean;
  command?: string;
  args: string[];
}

export interface YSweetProviderHealth {
  mode: YSweetProviderMode;
  ready: boolean;
  storeReady: boolean;
  serverUrl: string;
  error: string | null;
}

export type SpawnedYSweetChild = EventEmitter & {
  pid?: number;
  killed?: boolean;
  kill(signal?: NodeJS.Signals): boolean;
};

export interface YSweetProviderHandle {
  mode: YSweetProviderMode;
  serverUrl: string;
  connectionString?: string;
  auth?: string;
  serverToken?: string;
  child?: SpawnedYSweetChild;
  processError?: string | null;
}

type EnvSource = Record<string, string | undefined>;

interface LoadYSweetProviderProcessConfigOptions {
  requireAuth?: boolean;
  requireServerToken?: boolean;
  requireStorePath?: boolean;
  cwd?: string;
}

interface StartYSweetProviderProcessDeps {
  spawn?: (command: string, args: string[], options: SpawnOptions) => SpawnedYSweetChild;
}

interface ReadYSweetProviderHealthDeps {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const defaultServerUrl = 'http://127.0.0.1:8080';
const defaultHost = '127.0.0.1';
const defaultPort = 8080;
const defaultCheckpointFrequencySeconds = 10;
const defaultHealthProbeTimeoutMs = 1500;
const defaultStorePath = '.marklab-provider-data/ysweet';
const defaultYSweetCommandPath = 'apps/api/node_modules/.bin/y-sweet';
const childEnvAllowlist = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'NODE_ENV',
  'RUST_LOG',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'AWS_PROFILE',
  'AWS_SDK_LOAD_CONFIG',
  'AWS_ENDPOINT_URL',
  'AWS_ENDPOINT_URL_S3',
  'AWS_S3_USE_PATH_STYLE',
] as const;

function raw(env: EnvSource, key: string): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

function parseMode(value: string | undefined): YSweetProviderMode {
  if (!value) return 'disabled';
  if (value === 'disabled' || value === 'external' || value === 'process') return value;
  throw new Error('MARKLAB_YSWEET_PROVIDER_MODE must be disabled, external, or process');
}

function parsePositiveInteger(value: string | undefined, key: string, fallback: number): number {
  if (!value) return fallback;
  if (!/^\d+$/u.test(value)) throw new Error(`${key} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${key} must be a positive integer`);
  return parsed;
}

function parseBoolean(value: string | undefined, key: string, fallback: boolean): boolean {
  if (!value) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${key} must be true or false`);
}

function normalizeUrl(value: string, key: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('bad_protocol');
    return url.toString().replace(/\/$/u, '');
  } catch {
    throw new Error(`${key} must be a valid http(s) URL`);
  }
}

function portFromServerUrl(serverUrl: string): number {
  const url = new URL(serverUrl);
  if (url.port) return Number(url.port);
  return url.protocol === 'https:' ? 443 : defaultPort;
}

export function buildYSweetConnectionString(input: { serverUrl: string; auth?: string }): string {
  const serverUrl = new URL(input.serverUrl);
  const protocol = serverUrl.protocol === 'https:' ? 'yss:' : 'ys:';
  const username = input.auth ? `${encodeURIComponent(input.auth)}@` : '';
  const pathname = serverUrl.pathname === '/' ? '' : serverUrl.pathname;
  return `${protocol}//${username}${serverUrl.host}${pathname}`;
}

function serverTokenFromConnectionString(connectionString: string | undefined): string | undefined {
  if (!connectionString) return undefined;
  try {
    const url = new URL(connectionString);
    return url.username ? decodeURIComponent(url.username) : undefined;
  } catch {
    return undefined;
  }
}

function defaultYSweetCommand(cwd: string): string {
  const workspaceCommand = resolve(cwd, defaultYSweetCommandPath);
  if (existsSync(workspaceCommand)) return workspaceCommand;
  return resolve(cwd, 'node_modules/.bin/y-sweet');
}

function normalizeStorePath(value: string, cwd: string): string {
  if (value.startsWith('s3://')) return value;
  return resolve(cwd, value);
}

function buildYSweetChildEnv(config: YSweetProviderProcessConfig, source: EnvSource = process.env): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {};
  for (const key of childEnvAllowlist) {
    const value = source[key];
    if (value) childEnv[key] = value;
  }
  if (config.auth) childEnv.Y_SWEET_AUTH = config.auth;
  return childEnv;
}

export function loadYSweetProviderProcessConfig(
  env: EnvSource = process.env,
  options: LoadYSweetProviderProcessConfigOptions = {},
): YSweetProviderProcessConfig {
  const cwd = options.cwd ?? process.cwd();
  const mode = parseMode(raw(env, 'MARKLAB_YSWEET_PROVIDER_MODE'));
  const serverUrl = normalizeUrl(raw(env, 'MARKLAB_YSWEET_SERVER_URL') ?? defaultServerUrl, 'MARKLAB_YSWEET_SERVER_URL');
  const publicUrlPrefix = normalizeUrl(raw(env, 'MARKLAB_YSWEET_PUBLIC_URL_PREFIX') ?? serverUrl, 'MARKLAB_YSWEET_PUBLIC_URL_PREFIX');
  const auth = raw(env, 'MARKLAB_YSWEET_AUTH');
  const rawConnectionString = raw(env, 'MARKLAB_YSWEET_CONNECTION_STRING');
  const serverToken = raw(env, 'MARKLAB_YSWEET_SERVER_TOKEN') ?? serverTokenFromConnectionString(rawConnectionString);
  const connectionString = mode === 'disabled'
    ? undefined
    : rawConnectionString ?? buildYSweetConnectionString({ serverUrl, ...(serverToken ? { auth: serverToken } : {}) });
  const host = raw(env, 'MARKLAB_YSWEET_HOST') ?? defaultHost;
  const port = parsePositiveInteger(raw(env, 'MARKLAB_YSWEET_PORT'), 'MARKLAB_YSWEET_PORT', portFromServerUrl(serverUrl));
  const checkpointFrequencySeconds = parsePositiveInteger(
    raw(env, 'MARKLAB_YSWEET_CHECKPOINT_FREQ_SECONDS'),
    'MARKLAB_YSWEET_CHECKPOINT_FREQ_SECONDS',
    defaultCheckpointFrequencySeconds,
  );
  const skipGc = parseBoolean(raw(env, 'MARKLAB_YSWEET_SKIP_GC'), 'MARKLAB_YSWEET_SKIP_GC', false);
  if (skipGc) throw new Error('MARKLAB_YSWEET_SKIP_GC=true is not supported by y-sweet 0.9.1');
  const storePathRaw = raw(env, 'MARKLAB_YSWEET_STORE_PATH');
  const storePath = mode === 'process'
    ? storePathRaw ? normalizeStorePath(storePathRaw, cwd) : resolve(cwd, defaultStorePath)
    : storePathRaw ? normalizeStorePath(storePathRaw, cwd) : undefined;
  const processStorePath = storePath ?? resolve(cwd, defaultStorePath);

  if (mode === 'process') {
    if (options.requireAuth && !auth) throw new Error('MARKLAB_YSWEET_AUTH is required');
    if (options.requireStorePath && !storePathRaw) throw new Error('MARKLAB_YSWEET_STORE_PATH is required');
  }
  if (mode !== 'disabled' && options.requireServerToken && !serverToken) {
    throw new Error('MARKLAB_YSWEET_SERVER_TOKEN is required');
  }

  const command = mode === 'process' ? raw(env, 'MARKLAB_YSWEET_COMMAND') ?? defaultYSweetCommand(cwd) : undefined;
  const args = mode === 'process'
    ? [
        'serve',
        processStorePath,
        '--host',
        host,
        '--port',
        String(port),
        '--checkpoint-freq-seconds',
        String(checkpointFrequencySeconds),
        '--url-prefix',
        publicUrlPrefix,
        '--prod',
      ]
    : [];

  return {
    mode,
    serverUrl,
    ...(connectionString ? { connectionString } : {}),
    publicUrlPrefix,
    ...(storePath ? { storePath } : {}),
    ...(auth ? { auth } : {}),
    ...(serverToken ? { serverToken } : {}),
    host,
    port,
    checkpointFrequencySeconds,
    skipGc,
    ...(command ? { command } : {}),
    args,
  };
}

export function startYSweetProviderProcess(
  config: YSweetProviderProcessConfig,
  deps: StartYSweetProviderProcessDeps = {},
): YSweetProviderHandle {
  if (config.mode !== 'process') {
    return {
      mode: config.mode,
      serverUrl: config.serverUrl,
      ...(config.connectionString ? { connectionString: config.connectionString } : {}),
      ...(config.auth ? { auth: config.auth } : {}),
      ...(config.serverToken ? { serverToken: config.serverToken } : {}),
    };
  }
  if (!config.command) throw new Error('ysweet_process_command_missing');
  const spawn = deps.spawn ?? ((command: string, args: string[], options: SpawnOptions) => (
    nodeSpawn(command, args, options) as SpawnedYSweetChild
  ));
  const child = spawn(config.command, config.args, {
    detached: true,
    env: buildYSweetChildEnv(config),
    stdio: 'ignore',
  });
  const handle: YSweetProviderHandle = {
    mode: 'process',
    serverUrl: config.serverUrl,
    ...(config.connectionString ? { connectionString: config.connectionString } : {}),
    ...(config.auth ? { auth: config.auth } : {}),
    ...(config.serverToken ? { serverToken: config.serverToken } : {}),
    child,
  };
  child.on('error', (error: unknown) => {
    handle.processError = error instanceof Error ? error.message : 'ysweet_process_error';
  });
  return handle;
}

export async function stopYSweetProviderProcess(handle: YSweetProviderHandle | undefined): Promise<void> {
  if (!handle?.child || handle.child.killed) return;
  const child = handle.child;
  let exitedCleanly = false;
  const exited = once(child, 'exit')
    .then(() => {
      exitedCleanly = true;
    })
    .catch(() => undefined);
  const killGroup = (signal: NodeJS.Signals) => {
    if (child.pid) {
      process.kill(-child.pid, signal);
      return;
    }
    child.kill(signal);
  };
  try {
    killGroup('SIGINT');
  } catch {
    child.kill('SIGINT');
  }
  await Promise.race([
    exited,
    new Promise((resolve) => {
      setTimeout(resolve, 2500);
    }),
  ]);
  if (!exitedCleanly && !child.killed) {
    try {
      killGroup('SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  }
}

async function readJsonOk(response: Response): Promise<boolean> {
  if (!response.ok) return false;
  try {
    const body = await response.json() as { ok?: unknown };
    return body.ok === true;
  } catch {
    return false;
  }
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  input: string,
  init: RequestInit | undefined,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  let timeout: NodeJS.Timeout | undefined;
  let timedOut = false;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error('provider_health_timeout'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      fetchImpl(input, {
        ...init,
        signal: controller.signal,
      }),
      timeoutPromise,
    ]);
  } catch (error) {
    if (timedOut) throw new Error('provider_health_timeout');
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function readYSweetProviderHealth(
  handle: YSweetProviderHandle,
  deps: ReadYSweetProviderHealthDeps = {},
): Promise<YSweetProviderHealth> {
  if (handle.mode === 'disabled') {
    return { mode: 'disabled', ready: false, storeReady: false, serverUrl: handle.serverUrl, error: 'provider_disabled' };
  }
  if (handle.processError) {
    return {
      mode: handle.mode,
      ready: false,
      storeReady: false,
      serverUrl: handle.serverUrl,
      error: `provider_process_error:${handle.processError}`,
    };
  }

  const fetchImpl = deps.fetch ?? fetch;
  const timeoutMs = deps.timeoutMs ?? defaultHealthProbeTimeoutMs;
  const baseUrl = handle.serverUrl.replace(/\/$/u, '');
  try {
    const readyResponse = await fetchWithTimeout(fetchImpl, `${baseUrl}/ready`, undefined, timeoutMs);
    if (!readyResponse.ok) {
      return {
        mode: handle.mode,
        ready: false,
        storeReady: false,
        serverUrl: handle.serverUrl,
        error: `provider_ready_failed:${readyResponse.status}`,
      };
    }
    const headers = handle.serverToken ? { authorization: `Bearer ${handle.serverToken}` } : undefined;
    const storeResponse = await fetchWithTimeout(fetchImpl, `${baseUrl}/check_store`, {
      method: 'POST',
      ...(headers ? { headers } : {}),
    }, timeoutMs);
    const storeReady = await readJsonOk(storeResponse);
    return {
      mode: handle.mode,
      ready: storeReady,
      storeReady,
      serverUrl: handle.serverUrl,
      error: storeReady ? null : `provider_store_failed:${storeResponse.status}`,
    };
  } catch (error) {
    return {
      mode: handle.mode,
      ready: false,
      storeReady: false,
      serverUrl: handle.serverUrl,
      error: error instanceof Error ? error.message : 'provider_health_failed',
    };
  }
}
