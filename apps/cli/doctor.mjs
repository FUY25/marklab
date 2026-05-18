import { constants as fsConstants, existsSync, watch } from 'node:fs';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AgentCommandError, agentSuccess } from './agent-json.mjs';
import { defaultAlphaRelayConfig } from './relay-config.mjs';

const minimumNodeMajor = 20;

function parsePort(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const port = Number(value);
  return Number.isInteger(port) && port > 0 ? port : null;
}

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

async function checkRelayReachability(url, timeoutMs = 1500) {
  const httpUrl = url.replace(/^ws:/u, 'http:').replace(/^wss:/u, 'https:');
  return new Promise((resolveCheck) => {
    let settled = false;
    function finish(ok, details = undefined) {
      if (settled) return;
      settled = true;
      resolveCheck({ ok, details });
    }

    let parsed;
    try {
      parsed = new URL(httpUrl);
    } catch {
      finish(false, { reason: 'invalid_url' });
      return;
    }

    const client = parsed.protocol === 'https:' ? https : http;
    const request = client.request(
      {
        method: 'HEAD',
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname || '/',
        timeout: timeoutMs,
      },
      (response) => {
        response.resume();
        finish(Boolean(response.statusCode && response.statusCode < 500), { status: response.statusCode });
      },
    );
    request.on('error', (error) => finish(false, { reason: error.message }));
    request.on('timeout', () => {
      request.destroy();
      finish(false, { reason: 'timeout' });
    });
    request.end();
  });
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
    || defaultAlphaRelayConfig.publicApiUrl;
  const webUrl = env.MARKLAB_PUBLIC_WEB_URL?.trim()
    || defaultAlphaRelayConfig.publicWebUrl;
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

function repoRootFromCliDirectory() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../..');
}

function runProbeProcess(command, args, options = {}) {
  return new Promise((resolveCheck) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      resolveCheck({
        exitCode: null,
        signal: 'SIGTERM',
        stdout,
        stderr,
        timedOut: true,
      });
    }, options.timeoutMs ?? 15_000);

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveCheck({
        exitCode: null,
        signal: null,
        stdout,
        stderr,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    child.once('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveCheck({ exitCode, signal, stdout, stderr, timedOut: false });
    });
  });
}

export async function defaultMilkdownRuntimeProbe(options = {}) {
  const repoRoot = repoRootFromCliDirectory();
  const apiDirectory = resolve(repoRoot, 'apps/api');
  const runtimeModulePath = resolve(apiDirectory, 'src/services/milkdown-headless-runtime.ts');
  if (!existsSync(runtimeModulePath)) {
    return {
      ok: false,
      details: {
        reason: 'runtime_source_missing',
        runtimeModulePath,
      },
    };
  }

  const runtimeModuleUrl = pathToFileURL(runtimeModulePath).href;
  const probeScript = `
    async function main() {
      const { createHeadlessMilkdownRuntime } = await import(${JSON.stringify(runtimeModuleUrl)});
      const state = await createHeadlessMilkdownRuntime().initializeFromMarkdown('# MarkLab doctor\\n\\nRuntime probe.\\n');
      if (!(state.yjsState instanceof Uint8Array) || state.yjsState.byteLength === 0) throw new Error('empty_yjs_state');
      if (typeof state.markdown !== 'string' || !state.markdown.includes('MarkLab doctor')) throw new Error('markdown_probe_failed');
      console.log(JSON.stringify({ markdownLength: state.markdown.length, yjsStateBytes: state.yjsState.byteLength, hash: state.hash }));
    }
    main().catch((error) => {
      console.error(error);
      process.exit(1);
    });
  `;
  const localTsx = resolve(repoRoot, 'node_modules/.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
  const command = existsSync(localTsx) ? localTsx : 'pnpm';
  const args = existsSync(localTsx) ? ['-e', probeScript] : ['--dir', apiDirectory, 'exec', 'tsx', '-e', probeScript];
  const result = await runProbeProcess(command, args, {
    cwd: repoRoot,
    env: options.env,
    timeoutMs: options.timeoutMs,
  });

  if (result.exitCode !== 0) {
    return {
      ok: false,
      details: {
        command: existsSync(localTsx) ? 'tsx' : 'pnpm exec tsx',
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: Boolean(result.timedOut),
        stdout: truncateProbeText(result.stdout),
        stderr: truncateProbeText(result.stderr),
        error: result.error,
      },
    };
  }

  const outputLine = result.stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1);
  try {
    return {
      ok: true,
      details: {
        ...(outputLine ? JSON.parse(outputLine) : {}),
        command: existsSync(localTsx) ? 'tsx' : 'pnpm exec tsx',
      },
    };
  } catch {
    return {
      ok: true,
      details: {
        command: existsSync(localTsx) ? 'tsx' : 'pnpm exec tsx',
        stdout: truncateProbeText(result.stdout),
      },
    };
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

  if (await isLoopbackPortAvailable(0)) {
    addCheck(checks, 'loopback_bind', 'ok', 'Loopback bind is available.');
  } else {
    const message = 'Unable to bind a loopback port on 127.0.0.1.';
    errors.push({ code: 'loopback_bind_failed', message });
    addCheck(checks, 'loopback_bind', 'error', message);
  }

  const apiPort = parsePort(env.MARKLAB_API_PORT, 3011);
  const webPort = parsePort(env.MARKLAB_WEB_PORT, 5175);
  if (!apiPort || !webPort) {
    const message = 'MARKLAB_API_PORT and MARKLAB_WEB_PORT must be positive integers when set.';
    errors.push({ code: 'invalid_port_configuration', message });
    addCheck(checks, 'port_configuration', 'error', message, {
      MARKLAB_API_PORT: env.MARKLAB_API_PORT ?? null,
      MARKLAB_WEB_PORT: env.MARKLAB_WEB_PORT ?? null,
    });
  } else if (apiPort === webPort) {
    const message = 'MARKLAB_API_PORT and MARKLAB_WEB_PORT must be different.';
    errors.push({ code: 'duplicate_port_configuration', message });
    addCheck(checks, 'port_configuration', 'error', message, { apiPort, webPort });
  } else {
    const apiAvailable = await isLoopbackPortAvailable(apiPort);
    const webAvailable = await isLoopbackPortAvailable(webPort);
    const configuredPorts = Boolean(env.MARKLAB_API_PORT || env.MARKLAB_WEB_PORT);
    if (apiAvailable && webAvailable) {
      addCheck(checks, 'port_configuration', 'ok', 'API and web ports are available.', { apiPort, webPort });
    } else {
      const message = `Port conflict detected for ${!apiAvailable ? `API ${apiPort}` : ''}${!apiAvailable && !webAvailable ? ' and ' : ''}${!webAvailable ? `web ${webPort}` : ''}.`;
      const issue = { code: 'port_conflict', message, details: { apiPort, webPort, apiAvailable, webAvailable } };
      if (configuredPorts) errors.push(issue);
      else warnings.push(issue);
      addCheck(checks, 'port_configuration', configuredPorts ? 'error' : 'warning', message, issue.details);
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

  try {
    const milkdownRuntimeProbe = options.milkdownRuntimeProbe ?? defaultMilkdownRuntimeProbe;
    const runtime = await milkdownRuntimeProbe({
      env,
      timeoutMs: options.milkdownRuntimeTimeoutMs ?? 15_000,
    });
    if (runtime.ok) {
      addCheck(checks, 'milkdown_headless_runtime', 'ok', 'Milkdown headless runtime initialized successfully.', {
        ...runtime.details,
      });
    } else {
      const message = 'Milkdown headless runtime failed to initialize.';
      errors.push({ code: 'milkdown_headless_init_failed', message, details: runtime.details });
      addCheck(checks, 'milkdown_headless_runtime', 'error', message, runtime.details);
    }
  } catch (error) {
    const message = 'Milkdown headless runtime probe failed.';
    errors.push({ code: 'milkdown_headless_unavailable', message, details: { cause: error instanceof Error ? error.message : String(error) } });
    addCheck(checks, 'milkdown_headless_runtime', 'error', message);
  }

  const relayUrl = env.MARKLAB_RELAY_URL ?? env.MARKLAB_RELAY_WS_URL ?? env.MARKLAB_PUBLIC_RELAY_WS_URL;
  if (relayUrl) {
    const reachable = await checkRelayReachability(relayUrl);
    if (reachable.ok) {
      addCheck(checks, 'relay_reachability', 'ok', 'Configured relay URL is reachable.', { relayUrl, ...reachable.details });
    } else {
      const message = `Configured relay URL is not reachable: ${relayUrl}`;
      warnings.push({ code: 'relay_unreachable', message, details: reachable.details });
      addCheck(checks, 'relay_reachability', 'warning', message, reachable.details);
    }
  } else {
    addCheck(checks, 'relay_reachability', 'ok', 'No relay URL is configured; skipping relay reachability probe.');
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
