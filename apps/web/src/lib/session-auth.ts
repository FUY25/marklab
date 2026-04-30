const sessionAdminTokenKey = 'marklab.adminToken.v1';

function defaultSessionStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  return window.sessionStorage;
}

export function readSessionAdminToken(storage: Storage | null = defaultSessionStorage()): string | null {
  return storage?.getItem(sessionAdminTokenKey) ?? null;
}

export function writeSessionAdminToken(token: string, storage: Storage | null = defaultSessionStorage()): void {
  storage?.setItem(sessionAdminTokenKey, token);
}

export function clearSessionAdminToken(storage: Storage | null = defaultSessionStorage()): void {
  storage?.removeItem(sessionAdminTokenKey);
}
