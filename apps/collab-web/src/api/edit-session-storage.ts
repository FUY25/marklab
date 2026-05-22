import type { ActiveEditSession, RefreshableEditSession } from '@marklab/collab-editor';

const persistedSessionVersion = 1;
const persistedSessionKeyPrefix = 'marklab:collab-web:edit-session:v1';
const defaultPersistedEditSessionMaximumAgeMs = 30 * 24 * 60 * 60 * 1000;

export interface PersistedEditSession extends RefreshableEditSession {
  providerDocId: string;
}

interface PersistedEditSessionPayload extends PersistedEditSession {
  version: typeof persistedSessionVersion;
  routeTokenHash: string | null;
  updatedAt: string;
}

interface EditSessionStorageKeyInput {
  docId: string;
  branchId: string;
  token?: string | undefined;
}

export interface CleanupStalePersistedEditSessionsOptions {
  now?: Date;
  maximumAgeMs?: number;
  deleteIndexedDb?: (name: string) => void;
}

export interface CleanupStalePersistedEditSessionsResult {
  scanned: number;
  removed: number;
}

function localStorageOrNull(options: { requireWritable?: boolean } = {}): Storage | null {
  if (typeof window === 'undefined') return null;
  let storage: Storage;
  try {
    storage = window.localStorage;
  } catch {
    return null;
  }
  if (!options.requireWritable) return storage;
  try {
    const probeKey = 'marklab:collab-web:storage-probe';
    storage.setItem(probeKey, '1');
    storage.removeItem(probeKey);
    return storage;
  } catch {
    return null;
  }
}

function safeGetItem(storage: Storage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function safeRemoveItem(storage: Storage, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    // Storage can throw in private/quota-restricted browser modes.
  }
}

function encodeKeyPart(value: string): string {
  return encodeURIComponent(value);
}

function routeTokenForStorage(token: string | undefined): string | null {
  return token ?? null;
}

function routeTokenHashForStorage(token: string | undefined): string | null {
  const value = routeTokenForStorage(token);
  if (!value) return null;
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function persistedEditSessionStorageKey(input: EditSessionStorageKeyInput): string {
  return [
    persistedSessionKeyPrefix,
    encodeKeyPart(input.docId),
    encodeKeyPart(input.branchId),
    encodeKeyPart(routeTokenHashForStorage(input.token) ?? 'direct'),
  ].join(':');
}

function indexedDbPersistenceKey(providerDocId: string, sessionId: string): string {
  return `marklab:collab-web:${providerDocId}:${sessionId}`;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function parsePersistedEditSession(value: unknown): PersistedEditSessionPayload | null {
  if (!value || typeof value !== 'object') return null;
  const session = value as Partial<PersistedEditSessionPayload>;
  if (
    session.version !== persistedSessionVersion ||
    !isString(session.docId) ||
    !isString(session.branchId) ||
    !(session.routeTokenHash === null || isString(session.routeTokenHash)) ||
    !isString(session.sessionId) ||
    !isString(session.refreshToken) ||
    !isString(session.providerDocId) ||
    !isString(session.updatedAt)
  ) {
    return null;
  }
  return session as PersistedEditSessionPayload;
}

export function loadPersistedEditSession(input: EditSessionStorageKeyInput): PersistedEditSession | null {
  const storage = localStorageOrNull();
  if (!storage) return null;
  const key = persistedEditSessionStorageKey(input);
  const raw = safeGetItem(storage, key);
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    safeRemoveItem(storage, key);
    return null;
  }
  const session = parsePersistedEditSession(parsed);
  if (
    !session ||
    session.docId !== input.docId ||
    session.branchId !== input.branchId ||
    session.routeTokenHash !== routeTokenHashForStorage(input.token)
  ) {
    safeRemoveItem(storage, key);
    return null;
  }
  return {
    docId: session.docId,
    branchId: session.branchId,
    sessionId: session.sessionId,
    refreshToken: session.refreshToken,
    providerDocId: session.providerDocId,
  };
}

export function persistEditSession(input: EditSessionStorageKeyInput, session: ActiveEditSession): void {
  const storage = localStorageOrNull({ requireWritable: true });
  if (!storage) return;
  if (session.docId !== input.docId || session.branchId !== input.branchId) return;
  const payload: PersistedEditSessionPayload = {
    version: persistedSessionVersion,
    docId: session.docId,
    branchId: session.branchId,
    routeTokenHash: routeTokenHashForStorage(input.token),
    sessionId: session.sessionId,
    refreshToken: session.refreshToken,
    providerDocId: session.providerToken.providerDocId,
    updatedAt: new Date().toISOString(),
  };
  try {
    storage.setItem(persistedEditSessionStorageKey(input), JSON.stringify(payload));
  } catch {
    // Losing reload persistence must not invalidate an already-issued edit session.
  }
}

export function clearPersistedEditSession(input: EditSessionStorageKeyInput): void {
  const storage = localStorageOrNull();
  if (!storage) return;
  safeRemoveItem(storage, persistedEditSessionStorageKey(input));
}

function defaultDeleteIndexedDb(name: string): void {
  if (typeof indexedDB === 'undefined') return;
  try {
    indexedDB.deleteDatabase(name);
  } catch {
    // Stale browser caches are best-effort cleanup only.
  }
}

export function cleanupStalePersistedEditSessions(
  options: CleanupStalePersistedEditSessionsOptions = {},
): CleanupStalePersistedEditSessionsResult {
  const storage = localStorageOrNull();
  if (!storage) return { scanned: 0, removed: 0 };
  const now = options.now ?? new Date();
  const maximumAgeMs = options.maximumAgeMs ?? defaultPersistedEditSessionMaximumAgeMs;
  const deleteIndexedDb = options.deleteIndexedDb ?? defaultDeleteIndexedDb;
  let scanned = 0;
  let removed = 0;
  const keys: string[] = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(`${persistedSessionKeyPrefix}:`)) keys.push(key);
    }
  } catch {
    return { scanned, removed };
  }

  for (const key of keys) {
    scanned += 1;
    const raw = safeGetItem(storage, key);
    let parsed: unknown;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      safeRemoveItem(storage, key);
      removed += 1;
      continue;
    }
    const session = parsePersistedEditSession(parsed);
    const updatedAtMs = session ? Date.parse(session.updatedAt) : Number.NaN;
    if (!session || !Number.isFinite(updatedAtMs) || now.getTime() - updatedAtMs > maximumAgeMs) {
      safeRemoveItem(storage, key);
      if (session) deleteIndexedDb(indexedDbPersistenceKey(session.providerDocId, session.sessionId));
      removed += 1;
    }
  }

  return { scanned, removed };
}
