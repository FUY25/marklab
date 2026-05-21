import {
  loadYSweetProviderProcessConfig,
  type YSweetProviderMode,
  type YSweetProviderProcessConfig,
} from '../provider/ysweet-provider-process';

export type ApiEnvMode = 'development' | 'production';

export interface ApiEnv {
  mode: ApiEnvMode;
  port: number;
  databaseUrl?: string;
  requireAuth: boolean;
  publicWebUrl: string;
  publicApiUrl: string;
  ysweetProviderMode: YSweetProviderMode;
  ysweetServerUrl: string;
  ysweetPublicUrlPrefix: string;
  ysweetStorePath?: string;
  ysweetAuth?: string;
  ysweetServerToken?: string;
  ysweetConnectionString?: string;
  ysweetHost: string;
  ysweetPort: number;
  ysweetCheckpointFreqSeconds: number;
  ysweetSkipGc: boolean;
  allowedOrigins: string[];
}

export type EnvSource = Record<string, string | undefined>;

export class EnvValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid MarkLab environment: ${issues.join('; ')}`);
    this.name = 'EnvValidationError';
  }
}

const defaultPort = 3001;
const defaultWebUrl = 'http://127.0.0.1:5175';

const developmentCorsOrigins = [
  'http://127.0.0.1:5173',
  'http://localhost:5173',
  'http://127.0.0.1:5174',
  'http://localhost:5174',
  defaultWebUrl,
  'http://localhost:5175',
  'http://127.0.0.1:5176',
  'http://localhost:5176',
  'http://127.0.0.1:5177',
  'http://localhost:5177',
];

function raw(env: EnvSource, key: string): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

function parsePositiveInteger(value: string | undefined, key: string, issues: string[], fallback?: number): number {
  if (!value) {
    if (fallback !== undefined) return fallback;
    issues.push(`${key} is required`);
    return 0;
  }

  if (!/^\d+$/u.test(value)) {
    issues.push(`${key} must be a positive integer`);
    return 0;
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    issues.push(`${key} must be a positive integer`);
    return 0;
  }
  return parsed;
}

function parseBoolean(value: string | undefined, key: string, issues: string[], fallback: boolean): boolean {
  if (!value) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  issues.push(`${key} must be true or false`);
  return fallback;
}

function parseRequiredUrl(
  value: string | undefined,
  key: string,
  issues: string[],
  options: { protocols: string[]; fallback?: string },
): URL | null {
  const resolved = value ?? options.fallback;
  if (!resolved) {
    issues.push(`${key} is required`);
    return null;
  }

  try {
    const url = new URL(resolved);
    if (!options.protocols.includes(url.protocol)) {
      issues.push(`${key} must use ${options.protocols.join(' or ')}`);
      return null;
    }
    return url;
  } catch {
    issues.push(`${key} must be a valid URL`);
    return null;
  }
}

function normalizeOrigin(value: string, issues: string[], key: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      issues.push(`${key} entries must use http:// or https://`);
      return null;
    }
    return url.origin;
  } catch {
    issues.push(`${key} entries must be valid origins`);
    return null;
  }
}

function parseAllowedOrigins(env: EnvSource, issues: string[], defaults: string[]): string[] {
  const allowed = new Set(defaults);
  const configured = raw(env, 'MARKLAB_ALLOWED_ORIGINS');
  if (!configured) return [...allowed];

  for (const candidate of configured.split(',')) {
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    const origin = normalizeOrigin(trimmed, issues, 'MARKLAB_ALLOWED_ORIGINS');
    if (origin) allowed.add(origin);
  }
  return [...allowed];
}

function formatUrl(url: URL | null, fallback: string): string {
  if (!url) return fallback;
  if (url.pathname === '/' && url.search === '' && url.hash === '') return url.origin;
  return url.toString();
}

function normalizedHost(url: URL): string {
  return url.hostname.replace(/^\[/u, '').replace(/\]$/u, '').toLowerCase();
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized === '0:0:0:0:0:0:0:1' ||
    /^127(?:\.\d{1,3}){3}$/u.test(normalized)
  );
}

function assertNoLoopbackPublicUrl(url: URL | null, key: string, issues: string[]): void {
  if (!url) return;
  const host = normalizedHost(url);
  if (host === 'localhost') {
    issues.push(`${key} must not use localhost in hosted production mode`);
    return;
  }
  if (isLoopbackHost(host)) {
    issues.push(`${key} must not use a loopback host in hosted production mode`);
  }
}

function assertAllowedHostCoverage(urls: URL[], allowedOrigins: string[], issues: string[]): void {
  const hosts = new Set(urls.map(normalizedHost));
  if (hosts.size <= 1) return;

  const allowedHosts = new Set(
    allowedOrigins.map((origin) => {
      try {
        return normalizedHost(new URL(origin));
      } catch {
        return '';
      }
    }),
  );

  const missingHosts = [...hosts].filter((host) => !allowedHosts.has(host));
  if (missingHosts.length > 0) {
    issues.push(`MARKLAB_ALLOWED_ORIGINS must include public URL hosts: ${missingHosts.join(', ')}`);
  }
}

function requireProductionValue(env: EnvSource, key: string, issues: string[]): string | undefined {
  const value = raw(env, key);
  if (!value) issues.push(`${key} is required`);
  return value;
}

export function loadApiEnv(env: EnvSource = process.env): ApiEnv {
  const issues: string[] = [];
  const productionMode = env.NODE_ENV === 'production';
  const mode: ApiEnvMode = productionMode ? 'production' : 'development';
  const port = parsePositiveInteger(raw(env, 'PORT'), 'PORT', issues, productionMode ? undefined : defaultPort);
  const localProductionSmoke = productionMode
    ? parseBoolean(raw(env, 'MARKLAB_LOCAL_PRODUCTION_SMOKE'), 'MARKLAB_LOCAL_PRODUCTION_SMOKE', issues, false)
    : false;
  const databaseUrl = raw(env, 'DATABASE_URL');
  const requireAuth = parseBoolean(raw(env, 'MARKLAB_REQUIRE_AUTH'), 'MARKLAB_REQUIRE_AUTH', issues, false);
  const publicWebUrl = parseRequiredUrl(raw(env, 'MARKLAB_PUBLIC_WEB_URL'), 'MARKLAB_PUBLIC_WEB_URL', issues, {
    protocols: ['http:', 'https:'],
    fallback: defaultWebUrl,
  });
  const publicApiUrl = parseRequiredUrl(raw(env, 'MARKLAB_PUBLIC_API_URL'), 'MARKLAB_PUBLIC_API_URL', issues, {
    protocols: ['http:', 'https:'],
    fallback: `http://127.0.0.1:${port || defaultPort}`,
  });
  let ysweetProviderConfig: YSweetProviderProcessConfig | undefined;
  try {
    ysweetProviderConfig = loadYSweetProviderProcessConfig(env, {
      requireAuth: productionMode && raw(env, 'MARKLAB_YSWEET_PROVIDER_MODE') === 'process',
      requireServerToken: productionMode,
      requireStorePath: productionMode && raw(env, 'MARKLAB_YSWEET_PROVIDER_MODE') === 'process',
    });
  } catch (error) {
    issues.push(error instanceof Error ? error.message : 'MARKLAB_YSWEET_PROVIDER_MODE is invalid');
  }
  const allowedOrigins = parseAllowedOrigins(env, issues, productionMode ? [] : developmentCorsOrigins);

  if (productionMode) {
    requireProductionValue(env, 'MARKLAB_PUBLIC_WEB_URL', issues);
    requireProductionValue(env, 'MARKLAB_PUBLIC_API_URL', issues);
    requireProductionValue(env, 'MARKLAB_ALLOWED_ORIGINS', issues);

    if (!ysweetProviderConfig || ysweetProviderConfig.mode === 'disabled') {
      issues.push('MARKLAB_YSWEET_PROVIDER_MODE is required');
    }
    if (ysweetProviderConfig && ysweetProviderConfig.mode !== 'process') {
      issues.push('MARKLAB_YSWEET_PROVIDER_MODE must be process in hosted production alpha');
    }
    if (ysweetProviderConfig?.mode === 'process') {
      requireProductionValue(env, 'MARKLAB_YSWEET_PUBLIC_URL_PREFIX', issues);
    }
    if (!databaseUrl) issues.push('DATABASE_URL is required');
    if (!requireAuth) issues.push('MARKLAB_REQUIRE_AUTH must be true in hosted production mode');
    if (ysweetProviderConfig && ysweetProviderConfig.mode !== 'disabled') {
      const ysweetPublicUrl = new URL(ysweetProviderConfig.publicUrlPrefix);
      if (!localProductionSmoke && ysweetPublicUrl.protocol !== 'https:') {
        issues.push('MARKLAB_YSWEET_PUBLIC_URL_PREFIX must use https:// in hosted production mode');
      }
      if (ysweetProviderConfig.mode === 'process' && ysweetPublicUrl.pathname !== '/') {
        issues.push('MARKLAB_YSWEET_PUBLIC_URL_PREFIX must not include a path in process mode');
      }
      if (ysweetProviderConfig.mode === 'process' && publicApiUrl && ysweetPublicUrl.origin !== publicApiUrl.origin) {
        issues.push('MARKLAB_YSWEET_PUBLIC_URL_PREFIX must match MARKLAB_PUBLIC_API_URL origin in process mode');
      }
    }
    if (!localProductionSmoke) {
      assertNoLoopbackPublicUrl(publicWebUrl, 'MARKLAB_PUBLIC_WEB_URL', issues);
      assertNoLoopbackPublicUrl(publicApiUrl, 'MARKLAB_PUBLIC_API_URL', issues);
      if (ysweetProviderConfig && ysweetProviderConfig.mode !== 'disabled') {
        assertNoLoopbackPublicUrl(new URL(ysweetProviderConfig.publicUrlPrefix), 'MARKLAB_YSWEET_PUBLIC_URL_PREFIX', issues);
      }
    }
    assertAllowedHostCoverage(
      [
        publicWebUrl,
        publicApiUrl,
      ].filter((url): url is URL => Boolean(url)),
      allowedOrigins,
      issues,
    );
  }

  if (issues.length > 0) throw new EnvValidationError(issues);

  return {
    mode,
    port,
    ...(databaseUrl ? { databaseUrl } : {}),
    requireAuth,
    publicWebUrl: formatUrl(publicWebUrl, defaultWebUrl),
    publicApiUrl: formatUrl(publicApiUrl, `http://127.0.0.1:${port}`),
    ysweetProviderMode: ysweetProviderConfig?.mode ?? 'disabled',
    ysweetServerUrl: ysweetProviderConfig?.serverUrl ?? 'http://127.0.0.1:8080',
    ysweetPublicUrlPrefix: ysweetProviderConfig?.publicUrlPrefix ?? 'http://127.0.0.1:8080',
    ...(ysweetProviderConfig?.storePath ? { ysweetStorePath: ysweetProviderConfig.storePath } : {}),
    ...(ysweetProviderConfig?.auth ? { ysweetAuth: ysweetProviderConfig.auth } : {}),
    ...(ysweetProviderConfig?.serverToken ? { ysweetServerToken: ysweetProviderConfig.serverToken } : {}),
    ...(ysweetProviderConfig?.connectionString ? { ysweetConnectionString: ysweetProviderConfig.connectionString } : {}),
    ysweetHost: ysweetProviderConfig?.host ?? '127.0.0.1',
    ysweetPort: ysweetProviderConfig?.port ?? 8080,
    ysweetCheckpointFreqSeconds: ysweetProviderConfig?.checkpointFrequencySeconds ?? 10,
    ysweetSkipGc: ysweetProviderConfig?.skipGc ?? false,
    allowedOrigins,
  };
}
