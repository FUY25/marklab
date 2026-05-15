import type { ActiveEditSession, RefreshableEditSession } from './collab-session';

const persistedSessionVersion = 1;

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
    'marklab:collab-web:edit-session:v1',
    encodeKeyPart(input.docId),
    encodeKeyPart(input.branchId),
    encodeKeyPart(routeTokenHashForStorage(input.token) ?? 'direct'),
  ].join(':');
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
