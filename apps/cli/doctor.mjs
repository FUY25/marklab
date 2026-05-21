import { constants as fsConstants, existsSync, watch } from 'node:fs';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AgentCommandError, agentSuccess } from './agent-json.mjs';

const minimumNodeMajor = 20;
const defaultAlphaPilot = {
  publicWebUrl: 'https://marklab-relay-alpha.fly.dev',
  publicApiUrl: 'https://marklab-relay-alpha.fly.dev',
};

function addCheck(checks, name, status, message, details = undefined) {
  const check = { name, status, message };
  if (details !== undefined) check.details = details;
  checks.push(check);
  return check;
}

function isLoopbackPortAvailable(port) {
  return new Promise((resolveCheck) => {
    const server = net.createServer();
    server.once('error', () => resolveCheck(false));
    server.once('listening', () => {
      server.close(() => resolveCheck(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

async function checkWatcherTempChange() {
  const directory = await mkdtemp(join(tmpdir(), 'marklab-doctor-watch-'));
  let watcher;
  try {
    const changed = new Promise((resolveChange) => {
      watcher = watch(directory, () => resolveChange(true));
      setTimeout(() => resolveChange(false), 1000).unref();
    });
    await writeFile(join(directory, 'probe.md'), `# MarkLab doctor\n${Date.now()}\n`, 'utf8');
    return Boolean(await changed);
  } finally {
    watcher?.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function pathStorageWarning(targetPath) {
  if (!targetPath) return null;
  const normalized = targetPath.toLowerCase();
  if (normalized.includes('icloud~') || normalized.includes('/mobile documents/')) {
    return 'Target file appears to be in iCloud Drive; sync latency can delay watcher events.';
  }
  if (normalized.includes('/dropbox/')) {
    return 'Target file appears to be in Dropbox; sync latency can delay watcher events.';
  }
  if (normalized.startsWith('/volumes/')) {
    return 'Target file appears to be on a mounted or network volume; file watching may be less reliable.';
  }
  return null;
}

function truncateProbeText(value, maxLength = 2000) {
  const text = String(value ?? '');
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/u, '');
}

function resolvePilotTarget(env) {
  const apiUrl = env.MARKLAB_CONTROL_PLANE_API_URL?.trim()
    || env.MARKLAB_PUBLIC_API_URL?.trim()
    || defaultAlphaPilot.publicApiUrl;
  const webUrl = env.MARKLAB_PUBLIC_WEB_URL?.trim()
    || defaultAlphaPilot.publicWebUrl;
  return {
    apiUrl: trimTrailingSlash(apiUrl),
    webUrl: trimTrailingSlash(webUrl),
    source: env.MARKLAB_CONTROL_PLANE_API_URL || env.MARKLAB_PUBLIC_API_URL || env.MARKLAB_PUBLIC_WEB_URL
      ? 'environment'
      : 'default-alpha',
  };
}

function resolveNativeAppPath(env) {
  const configuredPath = env.MARKLAB_APP_PATH?.trim() || env.MARKLAB_APP_BUNDLE_PATH?.trim();
  return configuredPath ? resolve(configuredPath) : null;
}

function nativeJoinScheme(env) {
  const scheme = env.MARKLAB_APP_URL_SCHEME?.trim() || 'marklab';
  return scheme.replace(/:.*$/u, '');
}

function validateNativeUrlScheme(scheme) {
  return /^[a-z][a-z0-9+.-]*$/iu.test(scheme);
}

function addNativeAppChecks(checks, warnings, env, platform = process.platform) {
  const appPath = resolveNativeAppPath(env);
  const appName = env.MARKLAB_APP_NAME?.trim() || 'MarkLab';
  if (appPath) {
    if (existsSync(appPath)) {
      addCheck(checks, 'native_app', 'ok', 'Configured MarkLab.app bundle path exists.', {
        appPath,
        source: 'environment',
      });
    } else {
      const message = 'Configured MarkLab.app bundle path does not exist.';
      warnings.push({ code: 'native_app_missing', message, details: { appPath } });
      addCheck(checks, 'native_app', 'warning', message, { appPath, source: 'environment' });
    }
  } else if (platform === 'darwin') {
    addCheck(checks, 'native_app', 'ok', 'No MarkLab.app bundle path configured; CLI will ask LaunchServices to open the app by name.', {
      appName,
      source: 'launch-services',
    });
  } else {
    const message = 'MarkLab.app native routing is only supported on macOS.';
    warnings.push({ code: 'native_app_platform_unsupported', message, details: { platform } });
    addCheck(checks, 'native_app', 'warning', message, { platform });
  }

  const scheme = nativeJoinScheme(env);
  if (!validateNativeUrlScheme(scheme)) {
    addCheck(checks, 'native_url_scheme', 'error', 'Native join URL scheme is invalid.', { scheme });
    return;
  }
  addCheck(checks, 'native_url_scheme', 'ok', 'Native join URL scheme is configured.', {
    scheme,
    example: `${scheme}://join?url=${encodeURIComponent('https://marklab-relay-alpha.fly.dev/collab?docId=...&branchId=...&token=...&mode=edit')}`,
  });
}

async function checkApiHealth(apiUrl, timeoutMs = 2500) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${apiUrl}/healthz`, {
      method: 'GET',
      signal: controller.signal,
    });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: truncateProbeText(text) };
    }
    const record = body && typeof body === 'object' ? body : {};
    return {
      ok: response.ok && record.ok !== false,
      status: response.status,
      schemaReady: record.schema?.ready === true,
      schemaMissing: Array.isArray(record.schema?.missing) ? record.schema.missing : [],
      providerReady: record.provider?.ready === true,
      providerStoreReady: record.provider?.storeReady === true,
      databaseReady: record.database?.ready === true,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function runDoctor(input = {}, options = {}) {
  const env = options.env ?? process.env;
  const checks = [];
  const errors = [];
  const warnings = [];
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const nodeMajor = Number(nodeVersion.split('.')[0]);
  if (nodeMajor >= minimumNodeMajor) {
    addCheck(checks, 'node_version', 'ok', `Node ${nodeVersion} is supported.`, { minimumMajor: minimumNodeMajor });
  } else {
    const message = `Node ${nodeVersion} is too old; MarkLab requires Node ${minimumNodeMajor} or newer.`;
    errors.push({ code: 'node_version_unsupported', message });
    addCheck(checks, 'node_version', 'error', message, { minimumMajor: minimumNodeMajor });
  }

  const installationMode = env.npm_config_global === 'true' ? 'global-npm' : env.npm_lifecycle_event ? 'workspace-script' : 'local-bin';
  addCheck(checks, 'installation_mode', 'ok', `CLI installation mode detected as ${installationMode}.`, {
    installationMode,
  });

  addNativeAppChecks(checks, warnings, env, options.platform ?? process.platform);
  const nativeSchemeCheck = checks.find((check) => check.name === 'native_url_scheme');
  if (nativeSchemeCheck?.status === 'error') {
    errors.push({
      code: 'native_url_scheme_invalid',
      message: nativeSchemeCheck.message,
      details: nativeSchemeCheck.details,
    });
  }

  const pilotTarget = resolvePilotTarget(env);
  try {
    new URL(pilotTarget.apiUrl);
    new URL(pilotTarget.webUrl);
    addCheck(checks, 'pilot_target', 'ok', `Pilot target uses ${pilotTarget.source} URLs.`, pilotTarget);
  } catch {
    const message = 'Configured MarkLab pilot API/web URLs are invalid.';
    errors.push({ code: 'invalid_pilot_target', message, details: pilotTarget });
    addCheck(checks, 'pilot_target', 'error', message, pilotTarget);
  }

  if (env.MARKLAB_DOCTOR_SKIP_NETWORK === '1') {
    addCheck(checks, 'api_health', 'warning', 'Skipped /healthz network probe.', { apiUrl: pilotTarget.apiUrl });
  } else {
    try {
      const health = await (options.apiHealthProbe ?? checkApiHealth)(pilotTarget.apiUrl, options.apiHealthTimeoutMs ?? 2500);
      const healthReady = health.ok && health.schemaReady && health.providerReady && health.providerStoreReady;
      if (healthReady) {
        addCheck(checks, 'api_health', 'ok', 'API /healthz reports schema and provider ready.', health);
      } else {
        const message = 'API /healthz is not fully ready.';
        warnings.push({ code: 'api_health_not_ready', message, details: health });
        addCheck(checks, 'api_health', 'warning', message, health);
      }
    } catch (error) {
      const message = 'Unable to reach API /healthz.';
      warnings.push({ code: 'api_health_unreachable', message, details: { apiUrl: pilotTarget.apiUrl, cause: error instanceof Error ? error.message : String(error) } });
      addCheck(checks, 'api_health', 'warning', message, { apiUrl: pilotTarget.apiUrl });
    }
  }

  let targetPath = null;
  if (input.file) {
    targetPath = resolve(input.file);
    if (!existsSync(targetPath)) {
      const message = `Target file does not exist: ${targetPath}`;
      errors.push({ code: 'target_file_missing', message, details: { path: targetPath } });
      addCheck(checks, 'target_file_permissions', 'error', message, { path: targetPath });
    } else {
      try {
        await access(targetPath, fsConstants.R_OK | fsConstants.W_OK);
        addCheck(checks, 'target_file_permissions', 'ok', 'Target file is readable and writable.', { path: targetPath });
      } catch (error) {
        const message = `Target file is not readable and writable: ${targetPath}`;
        errors.push({ code: 'target_file_permission_denied', message, details: { path: targetPath } });
        addCheck(checks, 'target_file_permissions', 'error', message, {
          path: targetPath,
          cause: error instanceof Error ? error.message : String(error),
        });
      }

      const warning = pathStorageWarning(targetPath);
      if (warning) {
        const issue = { code: 'cloud_or_network_storage', message: warning, details: { path: targetPath } };
        warnings.push(issue);
        addCheck(checks, 'target_storage', 'warning', warning, { path: targetPath });
      } else {
        addCheck(checks, 'target_storage', 'ok', 'Target file is on a normal local-looking path.', { path: targetPath });
      }
    }
  }

  try {
    if (await checkWatcherTempChange()) {
      addCheck(checks, 'watcher_temp_change', 'ok', 'File watcher observed a temporary file change.');
    } else {
      const message = 'File watcher did not observe a temporary file change within 1s.';
      warnings.push({ code: 'watcher_probe_slow', message });
      addCheck(checks, 'watcher_temp_change', 'warning', message);
    }
  } catch (error) {
    const message = 'File watcher probe failed.';
    errors.push({ code: 'watcher_probe_failed', message, details: { cause: error instanceof Error ? error.message : String(error) } });
    addCheck(checks, 'watcher_temp_change', 'error', message);
  }

  if (errors.length > 0) {
    throw new AgentCommandError('doctor_failed', 'MarkLab doctor found environment failures.', {
      errors,
      warnings,
      checks,
      targetPath,
    });
  }

  return agentSuccess({ errors, warnings, checks, targetPath });
}

export function printDoctorHuman(result, stderr = process.stderr) {
  const details = result.ok ? result : result.details;
  for (const check of details?.checks ?? []) {
    stderr.write(`${check.status.toUpperCase()} ${check.name}: ${check.message}\n`);
  }
}
