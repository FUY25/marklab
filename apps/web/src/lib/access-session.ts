const memoryStorage = new Map<string, string>();

function browserStorage(): Storage | null {
  if (typeof localStorage === 'undefined') return null;
  return localStorage;
}

function readValue(key: string): string | null {
  try {
    const stored = browserStorage()?.getItem(key) ?? memoryStorage.get(key) ?? null;
    const trimmed = stored?.trim() ?? '';
    return trimmed ? trimmed : null;
  } catch {
    const stored = memoryStorage.get(key)?.trim() ?? '';
    return stored ? stored : null;
  }
}

function writeValue(key: string, value: string): void {
  const normalized = value.trim();
  try {
    if (normalized) browserStorage()?.setItem(key, normalized);
    else browserStorage()?.removeItem(key);
  } catch {
    // Fall through to the in-memory mirror below.
  }

  if (normalized) memoryStorage.set(key, normalized);
  else memoryStorage.delete(key);
}

function createAccessClientId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `browser_${crypto.randomUUID()}`;
  }
  return `browser_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

export function readOrCreateAccessClientId(docId: string, grantId: string): string {
  const key = `marklab.accessClient.${docId}.${grantId}`;
  const existing = readValue(key);
  if (existing) return existing;

  const nextClientId = createAccessClientId();
  writeValue(key, nextClientId);
  return nextClientId;
}

export function readStoredCollaboratorName(scope: string): string | null {
  return readValue(`marklab.collaboratorName.${scope}`);
}

export function storeCollaboratorName(scope: string, name: string): void {
  writeValue(`marklab.collaboratorName.${scope}`, name);
}
