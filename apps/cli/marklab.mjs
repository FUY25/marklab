#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { basename, dirname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  canonicalRealpath,
  cleanupStaleRegistryEntries,
  createDaemonEntry,
  defaultDaemonRegistryPath,
  defaultMetadataPath,
  findDaemonByRealpath,
  registerDaemonEntry,
  stopDaemonEntry,
  stopDaemons,
  unregisterDaemonEntry,
} from './daemon-supervisor.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cliPath = fileURLToPath(import.meta.url);
const defaultApiPort = 3011;
const defaultWebPort = 5175;

export function printUsage() {
  console.log(`Usage:
  marklab open <file.md> [--background]
  marklab share <file.md>
  marklab join <edit-link> <file.md>
  marklab join <edit-link> --dir <dir> [--name <file.md>] [--create-dir]
  marklab share-state <file.md> [--json]
  marklab create-link <file.md> --role <view|edit>
  marklab revoke-link <file.md> <grant-id>
  marklab status
  marklab stop <file.md>
  marklab stop --all`);
}

function parseFlagValue(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  return value && !value.startsWith('--') ? value : null;
}

function positionalArgs(args, flagsWithValues = []) {
  const result = [];
  const valueFlags = new Set(flagsWithValues);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith('--')) {
      if (valueFlags.has(arg)) index += 1;
      continue;
    }
    result.push(arg);
  }
  return result;
}

export function parseCliArgs(argv) {
  const [command, ...rest] = argv;
  if (command === 'open') {
    const file = positionalArgs(rest)[0] ?? null;
    return {
      command,
      file,
      background: rest.includes('--background'),
    };
  }

  if (command === 'share') {
    const file = positionalArgs(rest)[0] ?? null;
    return { command, file };
  }

  if (command === 'share-state') {
    const file = positionalArgs(rest)[0] ?? null;
    return { command, file, json: rest.includes('--json') };
  }

  if (command === 'create-link') {
    const file = positionalArgs(rest, ['--role'])[0] ?? null;
    return {
      command,
      file,
      role: parseFlagValue(rest, '--role') ?? 'edit',
    };
  }

  if (command === 'revoke-link') {
    const positional = positionalArgs(rest);
    const file = positional[0] ?? null;
    const grantId = positional[1] ?? null;
    return { command, file, grantId };
  }

  if (command === 'join') {
    const positional = positionalArgs(rest, ['--dir', '--name']);
    return {
      command,
      link: positional[0] ?? null,
      file: positional[1] ?? null,
      dir: parseFlagValue(rest, '--dir'),
      name: parseFlagValue(rest, '--name'),
      createDir: rest.includes('--create-dir'),
      replace: rest.includes('--replace'),
      review: rest.includes('--review'),
      cancel: rest.includes('--cancel'),
    };
  }

  if (command === 'stop') {
    const file = positionalArgs(rest)[0] ?? null;
    return {
      command,
      file,
      all: rest.includes('--all'),
    };
  }

  if (command === 'status') return { command };

  if (command === '__serve') {
    const file = positionalArgs(rest, ['--api-port', '--web-port', '--token'])[0] ?? null;
    return {
      command,
      file,
      apiPort: Number(parseFlagValue(rest, '--api-port')),
      webPort: Number(parseFlagValue(rest, '--web-port')),
      token: parseFlagValue(rest, '--token'),
    };
  }

  return { command: command ?? 'help' };
}

function waitForHttp(url, timeoutMs = 30000) {
  const startedAt = Date.now();
  return new Promise((resolveWait, rejectWait) => {
    function attempt() {
      const request = http.get(url, (response) => {
        response.resume();
        if (response.statusCode && response.statusCode >= 200 && response.statusCode < 500) {
          resolveWait();
          return;
        }
        retry();
      });
      function retry() {
        if (Date.now() - startedAt > timeoutMs) {
          rejectWait(new Error(`Timed out waiting for ${url}`));
          return;
        }
        setTimeout(attempt, 350);
      }
      request.on('error', retry);
      request.setTimeout(1000, () => {
        request.destroy();
      });
    }
    attempt();
  });
}

function waitForChildExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolveWait) => {
    child.once('exit', () => resolveWait());
  });
}

function spawnPnpm(argsToRun, env, stdio = 'inherit') {
  return spawn('npx', ['-y', 'pnpm@10.0.0', ...argsToRun], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio,
  });
}

function openBrowser(url) {
  if (process.env.MARKLAB_NO_OPEN === 'true') return;
  if (process.platform === 'darwin') {
    spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
    return;
  }
  if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref();
    return;
  }
  spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
}

export function buildLocalUrls(apiPort, webPort, token) {
  const apiUrl = `http://127.0.0.1:${apiPort}`;
  const webUrl = `http://127.0.0.1:${webPort}`;
  return {
    apiUrl,
    webUrl,
    localUrl: `${webUrl}/local#token=${encodeURIComponent(token)}`,
  };
}

function isPortAvailable(port) {
  return new Promise((resolveCheck) => {
    const server = net.createServer();
    server.once('error', () => resolveCheck(false));
    server.once('listening', () => {
      server.close(() => resolveCheck(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

export async function choosePort(preferred, envName, env = process.env) {
  const configured = env[envName];
  if (configured) {
    const port = Number(configured);
    if (!Number.isInteger(port) || port <= 0) throw new Error(`${envName} must be a positive integer`);
    if (!(await isPortAvailable(port))) throw new Error(`${envName}=${port} is already in use`);
    return port;
  }

  for (let port = preferred; port < preferred + 50; port += 1) {
    if (await isPortAvailable(port)) return port;
  }

  throw new Error(`No available loopback port found near ${preferred}`);
}

export async function chooseLocalPorts(env = process.env) {
  if (env.MARKLAB_API_PORT && env.MARKLAB_API_PORT === env.MARKLAB_WEB_PORT) {
    throw new Error('MARKLAB_API_PORT and MARKLAB_WEB_PORT must be different');
  }
  const apiPort = await choosePort(defaultApiPort, 'MARKLAB_API_PORT', env);
  const webPort = await choosePort(defaultWebPort, 'MARKLAB_WEB_PORT', env);
  if (apiPort === webPort) throw new Error('MARKLAB_API_PORT and MARKLAB_WEB_PORT must be different');
  return { apiPort, webPort };
}

function shutdownChildren(children) {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }
}

async function stopChildrenAndExit(children, code) {
  shutdownChildren(children);
  await Promise.race([
    Promise.all(children.map(waitForChildExit)),
    new Promise((resolveWait) => {
      setTimeout(resolveWait, 5000);
    }),
  ]);
  process.exit(code);
}

export function serveLocalFile(input) {
  const token = input.token;
  const { apiUrl, webUrl, localUrl } = buildLocalUrls(input.apiPort, input.webPort, token);
  const stdio = input.stdio ?? 'inherit';
  const metadataPath = input.metadataPath ?? defaultMetadataPath();
  const children = [
    spawnPnpm(
      ['--filter', '@marklab/api', 'start'],
      {
        PORT: String(input.apiPort),
        MARKLAB_HOST: '127.0.0.1',
        MARKLAB_LOCAL_FILE: input.markdownPath,
        MARKLAB_LOCAL_TOKEN: token,
        MARKLAB_LOCAL_METADATA_PATH: metadataPath,
        MARKLAB_WEB_ORIGIN: webUrl,
        MARKLAB_REQUIRE_AUTH: 'false',
        ...(input.enableRelay !== false ? { MARKLAB_ENABLE_RELAY: 'true' } : {}),
        MARKLAB_PUBLIC_API_URL: apiUrl,
        MARKLAB_PUBLIC_WEB_URL: webUrl,
        MARKLAB_PUBLIC_RELAY_WS_URL: `ws://127.0.0.1:${input.apiPort}/relay`,
        MARKLAB_RELAY_WS_URL: `ws://127.0.0.1:${input.apiPort}/relay`,
        ...(input.relayJoin
          ? {
              MARKLAB_RELAY_ROOM_ID: input.relayJoin.relayRoomId,
              MARKLAB_RELAY_TOKEN: input.relayJoin.token,
              MARKLAB_RELAY_CLIENT_ID: input.relayJoin.clientId,
              MARKLAB_RELAY_DISPLAY_NAME: input.relayJoin.displayName,
              MARKLAB_RELAY_WS_URL: input.relayJoin.wsUrl,
            }
          : {}),
      },
      stdio,
    ),
    spawnPnpm(
      ['--filter', '@marklab/web', 'exec', 'vite', '--host', '127.0.0.1', '--port', String(input.webPort), '--strictPort'],
      {
        VITE_MARKLAB_API_URL: apiUrl,
        VITE_MARKLAB_WS_URL: `ws://127.0.0.1:${input.apiPort}/collab`,
      },
      stdio,
    ),
  ];

  let shuttingDown = false;
  for (const child of children) {
    child.on('exit', (code, signal) => {
      if (shuttingDown) return;
      shuttingDown = true;
      const label = child === children[0] ? 'API' : 'Web';
      if (code !== 0) {
        console.error(`${label} process exited${code === null ? '' : ` with code ${code}`}${signal ? ` (${signal})` : ''}.`);
      }
      shutdownChildren(children.filter((candidate) => candidate !== child));
      process.exit(code ?? 1);
    });
  }

  const handleSignal = (code) => {
    if (shuttingDown) return;
    shuttingDown = true;
    void stopChildrenAndExit(children, code);
  };
  process.once('SIGINT', () => handleSignal(130));
  process.once('SIGTERM', () => handleSignal(143));
  process.once('SIGHUP', () => handleSignal(129));

  return {
    apiUrl,
    webUrl,
    localUrl,
    children,
    waitReady: () => Promise.all([waitForHttp(`${apiUrl}/healthz`), waitForHttp(webUrl)]),
  };
}

async function resolveMarkdownFile(file) {
  const markdownPath = resolve(file);
  if (!existsSync(markdownPath)) throw new Error(`File not found: ${markdownPath}`);
  return canonicalRealpath(markdownPath);
}

async function openForeground(file) {
  const markdownPath = await resolveMarkdownFile(file);
  const existing = await findDaemonByRealpath(markdownPath);
  if (existing) {
    console.log(`MarkLab is already watching ${markdownPath}`);
    console.log(`Opening ${existing.localUrl}`);
    openBrowser(existing.localUrl);
    return;
  }

  const { apiPort, webPort } = await chooseLocalPorts();
  const token = randomBytes(24).toString('base64url');
  const session = serveLocalFile({ markdownPath, apiPort, webPort, token });
  await session.waitReady();
  console.log(`Opening ${session.localUrl}`);
  openBrowser(session.localUrl);
}

async function createLocalRelayLink(apiUrl, token, role) {
  const response = await fetch(`${apiUrl}/api/local/access-grants`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ role }),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Unable to create relay link: ${body}`);
  return JSON.parse(body);
}

async function shareForeground(file) {
  const markdownPath = await resolveMarkdownFile(file);
  const { apiPort, webPort } = await chooseLocalPorts();
  const token = randomBytes(24).toString('base64url');
  const session = serveLocalFile({ markdownPath, apiPort, webPort, token, enableRelay: true });
  await session.waitReady();
  const created = await createLocalRelayLink(session.apiUrl, token, 'edit');
  console.log(`Sharing ${markdownPath}`);
  console.log(`Edit link: ${created.url}`);
  console.log(`Local browser URL: ${session.localUrl}`);
  openBrowser(session.localUrl);
}

async function openBackground(file) {
  const markdownPath = await resolveMarkdownFile(file);
  const registryPath = defaultDaemonRegistryPath();
  const existing = await findDaemonByRealpath(markdownPath, registryPath);
  if (existing) {
    console.log(`MarkLab is already watching ${markdownPath}`);
    console.log(`Browser URL: ${existing.localUrl}`);
    console.log(`Stop with: marklab stop ${markdownPath}`);
    openBrowser(existing.localUrl);
    return;
  }

  const { apiPort, webPort } = await chooseLocalPorts();
  const token = randomBytes(24).toString('base64url');
  const { apiUrl, webUrl, localUrl } = buildLocalUrls(apiPort, webPort, token);
  const child = spawn(process.execPath, [cliPath, '__serve', markdownPath, '--api-port', String(apiPort), '--web-port', String(webPort), '--token', token], {
    cwd: repoRoot,
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      MARKLAB_LOCAL_DAEMON_REGISTRY_PATH: registryPath,
      MARKLAB_LOCAL_METADATA_PATH: defaultMetadataPath(),
    },
  });
  child.unref();

  const entry = createDaemonEntry({
    realpath: markdownPath,
    pid: child.pid,
    apiPort,
    webPort,
    apiUrl,
    webUrl,
    localUrl,
    token,
  });

  const registered = await registerDaemonEntry(entry, registryPath);
  if (!registered.registered) {
    try {
      process.kill(child.pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
    console.log(`MarkLab is already watching ${markdownPath}`);
    console.log(`Browser URL: ${registered.existing.localUrl}`);
    openBrowser(registered.existing.localUrl);
    return;
  }

  try {
    await Promise.all([waitForHttp(`${apiUrl}/healthz`), waitForHttp(webUrl)]);
  } catch (error) {
    try {
      process.kill(child.pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
    await unregisterDaemonEntry(entry.id, registryPath);
    throw error;
  }

  console.log(`Opened ${markdownPath}`);
  console.log(`Browser URL: ${localUrl}`);
  console.log('Sync is running in the background.');
  console.log(`Stop with: marklab stop ${markdownPath}`);
  openBrowser(localUrl);
}

async function printStatus() {
  const registryPath = defaultDaemonRegistryPath();
  const { daemons, removed } = await cleanupStaleRegistryEntries(registryPath);
  if (removed > 0) console.log(`Cleaned ${removed} stale MarkLab daemon${removed === 1 ? '' : 's'}.`);
  if (daemons.length === 0) {
    console.log('No MarkLab local daemons are running.');
    return;
  }

  for (const daemon of daemons) {
    let syncState = 'running';
    try {
      const response = await fetch(`${daemon.apiUrl}/api/local/document`, {
        headers: { Authorization: `Bearer ${daemon.token}` },
      });
      if (response.ok) {
        const summary = await response.json();
        syncState = summary.conflict ? `conflict: ${summary.conflict}` : 'running';
      }
    } catch {
      syncState = 'unreachable';
    }
    console.log(`${daemon.realpath}`);
    console.log(`  PID: ${daemon.pid}`);
    console.log(`  API: ${daemon.apiUrl}`);
    console.log(`  Web: ${daemon.webUrl}`);
    console.log(`  Browser URL: ${daemon.localUrl}`);
    console.log(`  Last sync state: ${syncState}`);
  }
}

async function requireRunningDaemon(file) {
  const registryPath = defaultDaemonRegistryPath();
  const markdownPath = await resolveMarkdownFile(file);
  const daemon = await findDaemonByRealpath(markdownPath, registryPath);
  if (!daemon) throw new Error('No running MarkLab daemon found for that file. Start one with marklab share <file.md>.');
  return daemon;
}

async function shareStateCommand(input) {
  const daemon = await requireRunningDaemon(input.file);
  const response = await fetch(`${daemon.apiUrl}/api/local/share-state`, {
    headers: { Authorization: `Bearer ${daemon.token}` },
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Unable to read share state: ${body}`);
  const state = JSON.parse(body);
  if (input.json) {
    console.log(JSON.stringify(state, null, 2));
    return;
  }
  console.log(`Relay room: ${state.relayRoomId ?? 'not shared'}`);
  console.log(`Host: ${state.hostOnline ? 'online' : 'offline'}`);
  for (const link of state.links) {
    console.log(`${link.role} ${link.grantId} sessions=${link.activeSessionCount}`);
  }
}

async function createLinkCommand(input) {
  if (input.role !== 'view' && input.role !== 'edit') throw new Error('--role must be view or edit');
  const daemon = await requireRunningDaemon(input.file);
  const created = await createLocalRelayLink(daemon.apiUrl, daemon.token, input.role);
  console.log(created.url);
}

async function revokeLinkCommand(input) {
  const daemon = await requireRunningDaemon(input.file);
  const response = await fetch(`${daemon.apiUrl}/api/local/access-grants/${encodeURIComponent(input.grantId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${daemon.token}` },
  });
  if (!response.ok) throw new Error(`Unable to revoke relay link: ${await response.text()}`);
  console.log(`Revoked ${input.grantId}`);
}

function parseRelayLink(link) {
  let url;
  try {
    url = new URL(link);
  } catch {
    throw new Error('join requires a valid relay edit link');
  }
  const match = /^\/relay\/([^/]+)$/u.exec(url.pathname);
  if (!match?.[1]) throw new Error('join requires a relay edit link');
  const token = url.searchParams.get('token');
  if (!token) throw new Error('join requires a relay token');
  const apiUrl = url.searchParams.get('apiUrl') ?? `${url.protocol}//${url.hostname}:3011`;
  return {
    relayRoomId: decodeURIComponent(match[1]),
    token,
    apiUrl,
  };
}

export function safeRelayJoinFilename(name) {
  const candidate = String(name ?? '').trim();
  if (!candidate) return 'shared-notes.md';
  if (candidate.includes('/') || candidate.includes('\\') || candidate.split(sep).length > 1) {
    throw new Error('--name must be a Markdown filename, not a path');
  }
  const base = basename(candidate);
  return base.toLowerCase().endsWith('.md') ? base : `${base}.md`;
}

async function joinCommand(input) {
  if (!input.link) throw new Error('join requires an edit link');
  const link = parseRelayLink(input.link);
  const accessResponse = await fetch(`${link.apiUrl}/api/relay/rooms/${encodeURIComponent(link.relayRoomId)}/access?token=${encodeURIComponent(link.token)}`);
  const accessBody = await accessResponse.text();
  if (!accessResponse.ok) throw new Error(`Unable to validate relay link: ${accessBody}`);
  const access = JSON.parse(accessBody);
  if (!access.canWrite) throw new Error('View links cannot start a local mirror. Ask for an edit link.');
  if (!access.hostOnline) throw new Error('Host offline. Ask the host to open MarkLab again.');
  if (access.stale) throw new Error('Shared relay state is stale. Ask the host to keep MarkLab open and try again.');

  let target;
  if (input.dir) {
    const directory = resolve(input.dir);
    if (!existsSync(directory)) {
      if (!input.createDir) throw new Error(`${directory} does not exist. Re-run with --create-dir to create it.`);
      await import('node:fs/promises').then(({ mkdir }) => mkdir(directory, { recursive: true }));
    } else {
      const { stat } = await import('node:fs/promises');
      const directoryStat = await stat(directory);
      if (!directoryStat.isDirectory()) throw new Error(`${directory} is not a directory.`);
    }
    target = resolve(directory, safeRelayJoinFilename(input.name ?? access.suggestedFilename ?? 'shared-notes.md'));
  } else if (input.file) {
    target = resolve(input.file);
  } else {
    throw new Error('join requires a target file or --dir');
  }

  if (existsSync(target)) {
    const { readFile } = await import('node:fs/promises');
    const existing = await readFile(target, 'utf8');
    if (existing.length > 0 && !input.replace) {
      if (input.cancel) {
        console.log('Join cancelled. No file was changed.');
        return;
      }
      if (input.review) throw new Error('Review conflict is deferred to Plan 3. No file was changed.');
      throw new Error('Target file is non-empty. Re-run with --replace to replace it, --review for Plan 3 handoff, or --cancel.');
    }
  }

  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, access.markdown ?? '', 'utf8');
  const { apiPort, webPort } = await chooseLocalPorts();
  const localToken = randomBytes(24).toString('base64url');
  const wsUrl = new URL(input.link).searchParams.get('wsUrl') ?? link.apiUrl.replace(/^http/u, 'ws').replace(/\/$/u, '') + '/relay';
  const session = serveLocalFile({
    markdownPath: target,
    apiPort,
    webPort,
    token: localToken,
    relayJoin: {
      relayRoomId: link.relayRoomId,
      token: link.token,
      clientId: `mirror_${randomBytes(12).toString('base64url')}`,
      displayName: input.name ?? 'Local mirror',
      wsUrl,
    },
  });
  await session.waitReady();
  console.log(`Joined relay room ${link.relayRoomId}`);
  console.log(`Local mirror file: ${target}`);
  console.log(`Local browser URL: ${session.localUrl}`);
}

async function stopCommand(input) {
  const registryPath = defaultDaemonRegistryPath();
  const { daemons } = await cleanupStaleRegistryEntries(registryPath);
  const targets = input.all
    ? daemons
    : [await findDaemonByRealpath(await resolveMarkdownFile(input.file), registryPath)].filter(Boolean);

  if (targets.length === 0) {
    console.log(input.all ? 'No MarkLab local daemons are running.' : 'No running MarkLab daemon found for that file.');
    return;
  }

  const results = await stopDaemons(targets, { registryPath });
  const failures = results.filter(({ result }) => !result.stopped);
  for (const { entry, result } of results) {
    if (result.stopped) {
      console.log(`Stopped ${entry.realpath}`);
    } else {
      console.error(`Failed to stop ${entry.realpath}; daemon left running. Run: marklab status`);
    }
  }
  if (failures.length > 0) process.exit(1);
}

async function serveCommand(input) {
  if (!input.file || !input.apiPort || !input.webPort || !input.token) throw new Error('invalid_internal_serve_args');
  const session = serveLocalFile({
    markdownPath: input.file,
    apiPort: input.apiPort,
    webPort: input.webPort,
    token: input.token,
    stdio: 'ignore',
  });
  await session.waitReady();
}

export async function main(argv = process.argv.slice(2)) {
  const input = parseCliArgs(argv);
  if (input.command === 'open' && input.file) {
    if (input.background) await openBackground(input.file);
    else await openForeground(input.file);
    return;
  }

  if (input.command === 'share' && input.file) {
    await shareForeground(input.file);
    return;
  }

  if (input.command === 'share-state' && input.file) {
    await shareStateCommand(input);
    return;
  }

  if (input.command === 'create-link' && input.file) {
    await createLinkCommand(input);
    return;
  }

  if (input.command === 'revoke-link' && input.file && input.grantId) {
    await revokeLinkCommand(input);
    return;
  }

  if (input.command === 'join') {
    await joinCommand(input);
    return;
  }

  if (input.command === 'status') {
    await printStatus();
    return;
  }

  if (input.command === 'stop' && (input.all || input.file)) {
    await stopCommand(input);
    return;
  }

  if (input.command === '__serve') {
    await serveCommand(input);
    return;
  }

  printUsage();
  process.exit(input.command === 'help' ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
