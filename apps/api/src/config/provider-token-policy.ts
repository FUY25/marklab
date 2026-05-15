import {
  OIDC_LOGIN_STATE_TTL_SECONDS as defaultOidcLoginStateTtlSeconds,
  PROVIDER_TOKEN_REFRESH_CHECK_INTERVAL_SECONDS as defaultProviderTokenRefreshCheckIntervalSeconds,
  PROVIDER_TOKEN_REFRESH_MARGIN_SECONDS as defaultProviderTokenRefreshMarginSeconds,
  PROVIDER_TOKEN_TTL_SECONDS as defaultProviderTokenTtlSeconds,
  USER_SESSION_TTL_SECONDS as defaultUserSessionTtlSeconds,
} from '@marklab/shared/src/provider-token-policy';

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
