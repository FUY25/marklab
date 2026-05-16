import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import {
  canonicalRealpath,
  cleanupStaleRegistryEntries,
  defaultDaemonRegistryPath,
  findDaemonByRealpath,
} from './daemon-supervisor.mjs';
import { AgentCommandError, agentSuccess } from './agent-json.mjs';

export function markdownHash(markdown) {
  return `sha256:${createHash('sha256').update(markdown, 'utf8').digest('hex')}`;
}

export function localDaemonHeaders(daemon, extraHeaders = {}) {
  return {
    Authorization: `Bearer ${daemon.token}`,
    ...extraHeaders,
  };
}

async function readResponseText(response) {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

export async function fetchLocalJson(daemon, path, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  let response;
  try {
    response = await fetchImpl(`${daemon.apiUrl}${path}`, {
      method: options.method ?? 'GET',
      headers: localDaemonHeaders(daemon, options.headers),
      body: options.body,
    });
  } catch (error) {
    throw new AgentCommandError('daemon_not_running', 'MarkLab daemon is not reachable.', {
      path: daemon.realpath,
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  const body = await readResponseText(response);
  if (!response.ok) {
    let responseError = null;
    try {
      responseError = body ? JSON.parse(body)?.error : null;
    } catch {
      responseError = null;
    }
    const mappedCode = typeof responseError === 'string' ? options.errorCodeByBody?.[responseError] : null;
    const mappedMessage = typeof responseError === 'string' ? options.errorMessageByBody?.[responseError] : null;
    throw new AgentCommandError(mappedCode ?? options.errorCode ?? 'daemon_not_running', mappedMessage ?? options.errorMessage ?? 'MarkLab daemon request failed.', {
      path: daemon.realpath,
      status: response.status,
      body,
    });
  }

  try {
    return body ? JSON.parse(body) : null;
  } catch {
    throw new AgentCommandError('daemon_not_running', 'MarkLab daemon returned invalid JSON.', {
      path: daemon.realpath,
      body,
    });
  }
}

export async function fetchOptionalLocalJson(daemon, path, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  let response;
  try {
    response = await fetchImpl(`${daemon.apiUrl}${path}`, {
      method: options.method ?? 'GET',
      headers: localDaemonHeaders(daemon, options.headers),
      body: options.body,
    });
  } catch {
    return null;
  }

  if (response.status === 404 || response.status === 501 || response.status === 503) {
    await readResponseText(response);
    return null;
  }
  if (!response.ok) return null;
  const body = await readResponseText(response);
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

export async function readLocalDocument(daemon, options = {}) {
  return fetchLocalJson(daemon, '/api/local/document', {
    ...options,
    errorCode: 'daemon_not_running',
    errorMessage: 'Unable to read local document state.',
  });
}

export async function readLocalShareState(daemon, options = {}) {
  return fetchOptionalLocalJson(daemon, '/api/local/share-state', options);
}

export async function readLocalConflictState(daemon, options = {}) {
  const paths = [
    '/api/local/document/share-state/conflicts/current',
    '/api/local/conflicts/current',
  ];
  for (const path of paths) {
    const state = await fetchOptionalLocalJson(daemon, path, options);
    if (state) return state;
  }
  return null;
}

export async function resolveExistingMarkdownFile(file) {
  if (!file) throw new AgentCommandError('invalid_target', 'A Markdown file path is required.');
  const target = resolve(file);
  if (!existsSync(target)) {
    throw new AgentCommandError('invalid_target', `File not found: ${target}`, { path: target });
  }
  return canonicalRealpath(target);
}

export async function findWatchedDaemon(file, options = {}) {
  const registryPath = options.registryPath ?? defaultDaemonRegistryPath();
  const markdownPath = await resolveExistingMarkdownFile(file);
  const daemon = await findDaemonByRealpath(markdownPath, registryPath, options.isAlive);
  if (!daemon) {
    throw new AgentCommandError('file_not_watched', 'No running MarkLab daemon is watching that file.', {
      path: markdownPath,
    });
  }
  return daemon;
}

function conflictMessageFromState(conflictState, documentState) {
  if (conflictState?.conflict && typeof conflictState.conflict === 'object') {
    if (conflictState.conflict.status === 'open') return 'Relay reconnect conflict. Review needed before syncing resumes.';
  }
  if (typeof conflictState?.message === 'string' && conflictState.message) return conflictState.message;
  if (typeof conflictState?.conflict === 'string' && conflictState.conflict) return conflictState.conflict;
  if (typeof conflictState?.reason === 'string' && conflictState.reason) return conflictState.reason;
  if (typeof documentState?.conflict === 'string' && documentState.conflict) return documentState.conflict;
  return null;
}

function hasOpenConflict(conflictState, documentState) {
  if (conflictState?.conflict && typeof conflictState.conflict === 'object') {
    return conflictState.conflict.status === 'open';
  }
  if (typeof conflictState?.hasConflict === 'boolean') return conflictState.hasConflict;
  if (typeof conflictState?.open === 'boolean') return conflictState.open;
  return Boolean(conflictMessageFromState(conflictState, documentState));
}

export function syncStateForDaemon(documentState, shareState, conflictState) {
  if (!documentState) return 'error';
  if (hasOpenConflict(conflictState, documentState)) return 'paused';
  if (shareState?.relayRoomId && shareState.hostOnline === false) return 'host_offline';
  if (documentState.historyLoadError) return 'error';
  return 'synced';
}

export async function statusEntryForDaemon(daemon, options = {}) {
  let documentState = null;
  let shareState = null;
  let conflictState = null;
  try {
    documentState = await readLocalDocument(daemon, options);
    shareState = await readLocalShareState(daemon, options);
    conflictState = await readLocalConflictState(daemon, options);
  } catch {
    // A live process with an unreachable API remains visible but is not syncable.
  }

  const relayRoomId = shareState?.relayRoomId ?? null;
  const hasConflict = hasOpenConflict(conflictState, documentState);
  const mode = shareState?.mode ?? (relayRoomId ? 'relay-host' : 'local');
  return {
    path: documentState?.absolutePath ?? daemon.realpath,
    displayName: documentState?.displayName ?? daemon.displayName ?? basename(daemon.realpath),
    daemon: documentState ? 'running' : 'stopped',
    mode,
    syncState: syncStateForDaemon(documentState, shareState, conflictState),
    browserUrl: daemon.localUrl ?? null,
    pid: Number.isInteger(daemon.pid) ? daemon.pid : null,
    port: Number.isInteger(daemon.apiPort) ? daemon.apiPort : null,
    lastSyncAt: documentState?.updatedAt ?? daemon.updatedAt ?? null,
    hasConflict,
    relayRoomId,
  };
}

function missingStatusEntry(markdownPath) {
  return {
    path: markdownPath,
    displayName: basename(markdownPath),
    daemon: 'missing',
    mode: 'local',
    syncState: 'error',
    browserUrl: null,
    pid: null,
    port: null,
    lastSyncAt: null,
    hasConflict: false,
    relayRoomId: null,
  };
}

export async function buildAgentStatus(input = {}, options = {}) {
  const registryPath = options.registryPath ?? defaultDaemonRegistryPath();
  if (input.file) {
    const markdownPath = await resolveExistingMarkdownFile(input.file);
    const daemon = await findDaemonByRealpath(markdownPath, registryPath, options.isAlive);
    return agentSuccess({
      files: daemon ? [await statusEntryForDaemon(daemon, options)] : [missingStatusEntry(markdownPath)],
    });
  }

  const { daemons } = await cleanupStaleRegistryEntries(registryPath, options.isAlive);
  return agentSuccess({
    files: await Promise.all(daemons.map((daemon) => statusEntryForDaemon(daemon, options))),
  });
}

export async function listRecentFiles(options = {}) {
  const registryPath = options.registryPath ?? defaultDaemonRegistryPath();
  const { daemons } = await cleanupStaleRegistryEntries(registryPath, options.isAlive);
  const files = await Promise.all(
    daemons.map(async (daemon) => {
      const status = await statusEntryForDaemon(daemon, options);
      return {
        path: status.path,
        displayName: status.displayName,
        daemon: status.daemon,
        syncState: status.syncState,
        browserUrl: status.browserUrl,
        pid: status.pid,
        port: status.port,
        lastOpenedAt: daemon.startedAt ?? null,
        lastSyncAt: status.lastSyncAt,
        hasConflict: status.hasConflict,
        relayRoomId: status.relayRoomId,
      };
    }),
  );
  files.sort((left, right) => String(right.lastSyncAt ?? right.lastOpenedAt ?? '').localeCompare(String(left.lastSyncAt ?? left.lastOpenedAt ?? '')));
  return agentSuccess({ files });
}

export async function readCurrentDiskHash(file) {
  return markdownHash(await readFile(file, 'utf8'));
}
