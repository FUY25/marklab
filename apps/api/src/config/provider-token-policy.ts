const defaultProviderTokenTtlSeconds = 600;
const defaultProviderTokenRefreshMarginSeconds = 120;
const defaultProviderTokenRefreshCheckIntervalSeconds = 30;
const defaultUserSessionTtlSeconds = 60 * 60 * 24 * 30;
const defaultOidcLoginStateTtlSeconds = 10 * 60;

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const rawValue = process.env[name]?.trim();
  if (!rawValue) return fallback;
  if (!/^\d+$/u.test(rawValue)) throw new Error(`${name}_invalid`);
  const parsed = Number(rawValue);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name}_invalid`);
  return parsed;
}

export const PROVIDER_TOKEN_TTL_SECONDS = readPositiveIntegerEnv(
  'MARKLAB_PROVIDER_TOKEN_TTL_SECONDS',
  defaultProviderTokenTtlSeconds,
);
export const PROVIDER_TOKEN_REFRESH_MARGIN_SECONDS = readPositiveIntegerEnv(
  'MARKLAB_PROVIDER_TOKEN_REFRESH_MARGIN_SECONDS',
  defaultProviderTokenRefreshMarginSeconds,
);
export const PROVIDER_TOKEN_REFRESH_CHECK_INTERVAL_SECONDS = readPositiveIntegerEnv(
  'MARKLAB_PROVIDER_TOKEN_REFRESH_CHECK_INTERVAL_SECONDS',
  defaultProviderTokenRefreshCheckIntervalSeconds,
);
export const USER_SESSION_TTL_SECONDS = readPositiveIntegerEnv(
  'MARKLAB_USER_SESSION_TTL_SECONDS',
  defaultUserSessionTtlSeconds,
);
export const OIDC_LOGIN_STATE_TTL_SECONDS = readPositiveIntegerEnv(
  'MARKLAB_OIDC_LOGIN_STATE_TTL_SECONDS',
  defaultOidcLoginStateTtlSeconds,
);
