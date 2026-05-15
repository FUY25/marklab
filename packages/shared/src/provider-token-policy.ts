export const PROVIDER_TOKEN_TTL_SECONDS = 600;
export const PROVIDER_TOKEN_REFRESH_MARGIN_SECONDS = 120;
export const PROVIDER_TOKEN_REFRESH_CHECK_INTERVAL_SECONDS = 30;
export const USER_SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
export const OIDC_LOGIN_STATE_TTL_SECONDS = 10 * 60;

export interface ProviderTokenPolicy {
  ttlSeconds: number;
  refreshMarginSeconds: number;
  refreshCheckIntervalSeconds: number;
}

export const DEFAULT_PROVIDER_TOKEN_POLICY: ProviderTokenPolicy = {
  ttlSeconds: PROVIDER_TOKEN_TTL_SECONDS,
  refreshMarginSeconds: PROVIDER_TOKEN_REFRESH_MARGIN_SECONDS,
  refreshCheckIntervalSeconds: PROVIDER_TOKEN_REFRESH_CHECK_INTERVAL_SECONDS,
};
