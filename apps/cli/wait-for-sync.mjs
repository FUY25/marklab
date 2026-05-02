import {
  fetchOptionalLocalJson,
  findWatchedDaemon,
  readCurrentDiskHash,
  readLocalConflictState,
  readLocalDocument,
  readLocalShareState,
} from './recent-files.mjs';
import { AgentCommandError, agentSuccess } from './agent-json.mjs';

function sleep(ms) {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}

function conflictMessage(conflictState, documentState) {
  if (conflictState?.conflict && typeof conflictState.conflict === 'object') {
    if (conflictState.conflict.status === 'open') return 'Relay reconnect conflict. Review needed before syncing resumes.';
  }
  if (typeof conflictState?.message === 'string' && conflictState.message) return conflictState.message;
  if (typeof conflictState?.conflict === 'string' && conflictState.conflict) return conflictState.conflict;
  if (typeof conflictState?.reason === 'string' && conflictState.reason) return conflictState.reason;
  if (typeof documentState?.conflict === 'string' && documentState.conflict) return documentState.conflict;
  return null;
}

function latestVersionForHash(versionsState, hash) {
  const versions = Array.isArray(versionsState?.versions) ? versionsState.versions : [];
  return versions.find((version) => version.hash === hash)?.versionId ?? null;
}

export async function waitForSync(input, options = {}) {
  if (!input?.file) throw new AgentCommandError('invalid_target', 'wait requires a Markdown file path.');
  if (!input.synced) throw new AgentCommandError('invalid_target', 'wait currently requires --synced.');

  const timeoutMs = Number.isFinite(input.timeoutMs) ? input.timeoutMs : 10_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0) {
    throw new AgentCommandError('invalid_target', '--timeout must be a non-negative integer.', { timeoutMs: input.timeoutMs });
  }

  const startedAt = Date.now();
  const daemon = await findWatchedDaemon(input.file, options);
  const intervalMs = options.intervalMs ?? 200;

  while (true) {
    const documentState = await readLocalDocument(daemon, options);
    const conflictState = await readLocalConflictState(daemon, options);
    const message = conflictMessage(conflictState, documentState);
    if (message) {
      throw new AgentCommandError('sync_paused', 'MarkLab sync is paused because a conflict is open.', {
        path: daemon.realpath,
        conflict: message,
      });
    }

    const shareState = await readLocalShareState(daemon, options);
    if (shareState?.relayRoomId && shareState.hostOnline === false) {
      throw new AgentCommandError('host_offline', 'Relay host is offline; this file cannot sync through the relay.', {
        path: daemon.realpath,
        relayRoomId: shareState.relayRoomId,
      });
    }

    const diskHash = await readCurrentDiskHash(daemon.realpath);
    if (diskHash === documentState.hash) {
      const versionsState = await fetchOptionalLocalJson(daemon, '/api/local/versions', options);
      return agentSuccess({
        path: daemon.realpath,
        syncState: 'synced',
        observedHash: documentState.hash,
        versionId: latestVersionForHash(versionsState, documentState.hash),
        relayRevision: Number.isInteger(shareState?.sharedRevision) ? shareState.sharedRevision : null,
        waitedMs: Date.now() - startedAt,
      });
    }

    const waitedMs = Date.now() - startedAt;
    if (waitedMs >= timeoutMs) {
      throw new AgentCommandError('sync_timeout', 'Timed out waiting for MarkLab to observe the local file state.', {
        path: daemon.realpath,
        observedHash: documentState.hash,
        diskHash,
        waitedMs,
        timeoutMs,
      });
    }

    await sleep(Math.min(intervalMs, Math.max(0, timeoutMs - waitedMs)));
  }
}
