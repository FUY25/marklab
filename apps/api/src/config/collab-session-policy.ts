const defaultGuestEditSessionQuota = 3;
const defaultGuestEditSessionIdleTimeoutSeconds = 3600;

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const rawValue = process.env[name]?.trim();
  if (!rawValue) return fallback;
  if (!/^\d+$/u.test(rawValue)) throw new Error(`${name}_invalid`);
  const parsed = Number(rawValue);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name}_invalid`);
  return parsed;
}

export const GUEST_EDIT_SESSION_QUOTA = readPositiveIntegerEnv(
  'MARKLAB_GUEST_EDIT_SESSION_QUOTA',
  defaultGuestEditSessionQuota,
);

export const GUEST_EDIT_SESSION_IDLE_TIMEOUT_SECONDS = readPositiveIntegerEnv(
  'MARKLAB_GUEST_EDIT_SESSION_IDLE_TIMEOUT_SECONDS',
  defaultGuestEditSessionIdleTimeoutSeconds,
);
