import { randomUUID } from 'node:crypto';
import { open, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const registrySchemaVersion = 1;

export function defaultAppSupportDirectory(env = process.env, platform = process.platform) {
  if (env.MARKLAB_APP_SUPPORT_DIR?.trim()) return env.MARKLAB_APP_SUPPORT_DIR;
  if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'MarkLab');
  return join(env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'MarkLab');
}

export function defaultDaemonRegistryPath(env = process.env, platform = process.platform) {
  return env.MARKLAB_LOCAL_DAEMON_REGISTRY_PATH ?? join(defaultAppSupportDirectory(env, platform), 'local-daemons.json');
}

export function defaultMetadataPath(env = process.env, platform = process.platform) {
  return env.MARKLAB_LOCAL_METADATA_PATH ?? join(defaultAppSupportDirectory(env, platform), 'marklab-local.json');
}

export async function canonicalRealpath(filePath) {
  return realpath(resolve(filePath));
}

export function createDaemonEntry(input) {
  const now = new Date().toISOString();
  return {
    schemaVersion: registrySchemaVersion,
    id: input.id ?? randomUUID(),
    realpath: input.realpath,
    displayName: basename(input.realpath),
    pid: input.pid,
    apiPort: input.apiPort,
    webPort: input.webPort,
    apiUrl: input.apiUrl,
    webUrl: input.webUrl,
    localUrl: input.localUrl,
    token: input.token,
    startedAt: input.startedAt ?? now,
    updatedAt: input.updatedAt ?? now,
  };
}

export function isProcessRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function emptyRegistry() {
  return {
    schemaVersion: registrySchemaVersion,
    daemons: [],
  };
}

function parseRegistry(raw) {
  const parsed = JSON.parse(raw);
  if (!parsed || parsed.schemaVersion !== registrySchemaVersion || !Array.isArray(parsed.daemons)) {
    return emptyRegistry();
  }
  return {
    schemaVersion: registrySchemaVersion,
    daemons: parsed.daemons.filter((entry) => entry && entry.schemaVersion === registrySchemaVersion),
  };
}

export async function readDaemonRegistry(registryPath = defaultDaemonRegistryPath()) {
  try {
    return parseRegistry(await readFile(registryPath, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return emptyRegistry();
    return emptyRegistry();
  }
}

export async function writeDaemonRegistry(registry, registryPath = defaultDaemonRegistryPath()) {
  await mkdir(dirname(registryPath), { recursive: true });
  const temporaryPath = join(
    dirname(registryPath),
    `.${basename(registryPath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  await writeFile(temporaryPath, `${JSON.stringify(registry, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporaryPath, registryPath);
}

function delay(ms) {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}

export async function withRegistryLock(registryPath, callback, options = {}) {
  await mkdir(dirname(registryPath), { recursive: true });
  const lockPath = `${registryPath}.lock`;
  const timeoutMs = options.timeoutMs ?? 5000;
  const startedAt = Date.now();
  let handle;

  while (!handle) {
    try {
      handle = await open(lockPath, 'wx');
    } catch (error) {
      if (!error || error.code !== 'EEXIST' || Date.now() - startedAt > timeoutMs) throw error;
      await delay(50);
    }
  }

  try {
    return await callback();
  } finally {
    await handle.close();
    await rm(lockPath, { force: true });
  }
}

export async function cleanupStaleRegistryEntries(
  registryPath = defaultDaemonRegistryPath(),
  isAlive = isProcessRunning,
) {
  return withRegistryLock(registryPath, async () => {
    const registry = await readDaemonRegistry(registryPath);
    const running = registry.daemons.filter((entry) => isAlive(entry.pid));
    const removed = registry.daemons.length - running.length;
    if (removed > 0) await writeDaemonRegistry({ schemaVersion: registrySchemaVersion, daemons: running }, registryPath);
    return { daemons: running, removed };
  });
}

export async function registerDaemonEntry(entry, registryPath = defaultDaemonRegistryPath(), isAlive = isProcessRunning) {
  return withRegistryLock(registryPath, async () => {
    const registry = await readDaemonRegistry(registryPath);
    const running = registry.daemons.filter((candidate) => isAlive(candidate.pid));
    const existing = running.find((candidate) => candidate.realpath === entry.realpath);
    if (existing) {
      if (running.length !== registry.daemons.length) {
        await writeDaemonRegistry({ schemaVersion: registrySchemaVersion, daemons: running }, registryPath);
      }
      return { registered: false, existing };
    }

    const nextRegistry = {
      schemaVersion: registrySchemaVersion,
      daemons: [...running, entry],
    };
    await writeDaemonRegistry(nextRegistry, registryPath);
    return { registered: true, entry };
  });
}

export async function unregisterDaemonEntry(id, registryPath = defaultDaemonRegistryPath()) {
  return withRegistryLock(registryPath, async () => {
    const registry = await readDaemonRegistry(registryPath);
    const daemons = registry.daemons.filter((entry) => entry.id !== id);
    await writeDaemonRegistry({ schemaVersion: registrySchemaVersion, daemons }, registryPath);
  });
}

export async function findDaemonByRealpath(realpathValue, registryPath = defaultDaemonRegistryPath(), isAlive = isProcessRunning) {
  const { daemons } = await cleanupStaleRegistryEntries(registryPath, isAlive);
  return daemons.find((entry) => entry.realpath === realpathValue) ?? null;
}

export async function requestDaemonShutdown(entry, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(`${entry.apiUrl}/api/local/shutdown`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${entry.token}`,
      'Content-Type': 'application/json',
    },
  });
  if (response.ok) return { ok: true };
  return { ok: false, status: response.status, body: await response.text() };
}

export async function waitForProcessExit(pid, isAlive = isProcessRunning, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    if (!isAlive(pid)) return true;
    await delay(100);
  }
  return !isAlive(pid);
}

export function signalDaemonProcessTree(pid, signal = 'SIGTERM') {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

export async function stopDaemonEntry(entry, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const isAlive = options.isAlive ?? isProcessRunning;
  const registryPath = options.registryPath ?? defaultDaemonRegistryPath();
  const signalProcessTree = options.signalProcessTree ?? signalDaemonProcessTree;
  const shutdown = await requestDaemonShutdown(entry, fetchImpl);
  if (!shutdown.ok) {
    return {
      stopped: false,
      reason: 'flush_failed',
      shutdown,
    };
  }

  const exited = await waitForProcessExit(entry.pid, isAlive, options.timeoutMs ?? 5000);
  let processExited = exited;
  if (!processExited && options.killProcess !== false) {
    signalProcessTree(entry.pid, 'SIGTERM');
    processExited = await waitForProcessExit(entry.pid, isAlive, 2000);
  }

  if (!processExited) {
    return {
      stopped: false,
      reason: 'process_still_running',
      shutdown,
    };
  }

  await unregisterDaemonEntry(entry.id, registryPath);
  return { stopped: true };
}

export async function stopDaemons(entries, options = {}) {
  const results = [];
  for (const entry of entries) {
    results.push({ entry, result: await stopDaemonEntry(entry, options) });
  }
  return results;
}
