#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readlinkSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { basename, dirname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  AgentCommandError,
  agentSuccess,
  writeAgentError,
  writeAgentJson,
} from './agent-json.mjs';
import { installAgentInstructions, readAgentInstructions } from './agent-instructions.mjs';
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
import { runDoctor, printDoctorHuman } from './doctor.mjs';
import {
  buildAgentStatus,
  fetchLocalJson,
  findWatchedDaemon,
  listRecentFiles,
  readLocalConflictState,
  readLocalDocument,
} from './recent-files.mjs';
import { buildRelayJoinUrls, loadRelayConfig } from './relay-config.mjs';
import { waitForSync } from './wait-for-sync.mjs';

const cliRoot = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(cliRoot, '../..');
const packagedRuntimeRoot = resolve(cliRoot, 'runtime');
const repoRoot = existsSync(resolve(workspaceRoot, 'pnpm-workspace.yaml'))
  ? workspaceRoot
  : existsSync(resolve(packagedRuntimeRoot, 'pnpm-workspace.yaml'))
    ? packagedRuntimeRoot
    : cliRoot;
const cliPath = fileURLToPath(import.meta.url);
const defaultApiPort = 3011;
const defaultWebPort = 5175;

export function printUsage() {
  console.log(`Usage:
  marklab open <file.md> [--background]
  marklab share <file.md> [--json]
  marklab join <edit-link> <file.md>
  marklab join <edit-link> --dir <dir> [--name <file.md>] [--create-dir] [--background]
  marklab join <edit-link> --pick-dir [--background]
  marklab share-state <file.md> [--json]
  marklab create-link <file.md> --role <view|edit> [--json]
  marklab revoke-link <file.md> <grant-id> [--json]
  marklab status [file.md] [--json]
  marklab recent --json
  marklab wait <file.md> --synced --timeout 10000 --json
  marklab save-version <file.md> --message "Before AI edit" --json
  marklab versions <file.md> --json
  marklab conflict <file.md> --json
  marklab doctor [file.md] --json
  marklab agent instructions --target <codex|claude|cursor>
  marklab agent install --target codex --write AGENTS.md [--force]
  marklab stop <file.md>
  marklab stop --all`);
}

export function printCommandUsage(command) {
  if (command === 'open') {
    console.log(`Usage:
  marklab open <file.md>
  marklab open <file.md> --background

Open a local Markdown file in MarkLab. Foreground mode keeps the daemon attached to this terminal; background mode keeps it running until marklab stop.`);
    return;
  }
  if (command === 'share') {
    console.log(`Usage:
  marklab share <file.md> [--json]

Start sharing a local Markdown file. Foreground sharing stops when this terminal exits. Background hosting is available by opening the file with --background and creating links from that daemon.`);
    return;
  }
  if (command === 'join') {
    console.log(`Usage:
  marklab join <edit-link> <file.md>
  marklab join <edit-link> --dir <dir> [--name <file.md>] [--create-dir] [--background]
  marklab join <edit-link> --pick-dir [--background]

Join an edit link as a local Markdown mirror. Use --pick-dir to choose the destination folder with a system dialog. Foreground mode keeps the terminal attached; background mode keeps syncing until marklab stop. View links and host-offline links are rejected before directories, files, watchers, or daemons are created.`);
    return;
  }
  printUsage();
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
  const json = rest.includes('--json');
  if (!command || command === 'help' || command === '--help' || command === '-h') return { command: 'help', json };
  if (rest.includes('--help') || rest.includes('-h')) return { command: 'help', topic: command, json };
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
    return { command, file, json, daemonOnly: rest.includes('--daemon-only') };
  }

  if (command === 'share-state') {
    const file = positionalArgs(rest)[0] ?? null;
    return { command, file, json };
  }

  if (command === 'create-link') {
    const file = positionalArgs(rest, ['--role'])[0] ?? null;
    return {
      command,
      file,
      role: parseFlagValue(rest, '--role') ?? 'edit',
      json,
    };
  }

  if (command === 'revoke-link') {
    const positional = positionalArgs(rest);
    const file = positional[0] ?? null;
    const grantId = positional[1] ?? null;
    return { command, file, grantId, json };
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
      background: rest.includes('--background'),
      pickDir: rest.includes('--pick-dir'),
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

  if (command === 'status') {
    const file = positionalArgs(rest)[0] ?? null;
    return { command, file, json };
  }

  if (command === 'recent') return { command, json };

  if (command === 'wait') {
    const file = positionalArgs(rest, ['--timeout'])[0] ?? null;
    return {
      command,
      file,
      synced: rest.includes('--synced'),
      timeoutMs: Number(parseFlagValue(rest, '--timeout') ?? 10000),
      json,
    };
  }

  if (command === 'save-version') {
    const file = positionalArgs(rest, ['--message'])[0] ?? null;
    return {
      command,
      file,
      message: parseFlagValue(rest, '--message'),
      json,
    };
  }

  if (command === 'versions') {
    const file = positionalArgs(rest)[0] ?? null;
    return { command, file, json };
  }

  if (command === 'doctor') {
    const file = positionalArgs(rest)[0] ?? null;
    return { command, file, json };
  }

  if (command === 'conflict') {
    const file = positionalArgs(rest)[0] ?? null;
    return { command, file, json };
  }

  if (command === 'agent') {
    const [agentCommand, ...agentRest] = rest;
    return {
      command,
      agentCommand: agentCommand ?? null,
      target: parseFlagValue(agentRest, '--target'),
      writePath: parseFlagValue(agentRest, '--write'),
      force: agentRest.includes('--force'),
      json: rest.includes('--json'),
    };
  }

  if (['write', 'edit', 'hosted-write', 'hosted-edit'].includes(command)) {
    return { command, forbiddenAgentWrite: true, json };
  }

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

  return { command: command ?? 'help', json };
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

async function waitForSessionExit(session) {
  await Promise.all(session.children.map(waitForChildExit));
}

function captureCommand(command, args) {
  return new Promise((resolveCapture, rejectCapture) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.once('error', rejectCapture);
    child.once('exit', (code) => {
      if (code === 0 && stdout.trim()) {
        resolveCapture(stdout.trim());
        return;
      }
      rejectCapture(new Error(stderr.trim() || `${command} exited with code ${code ?? 'unknown'}`));
    });
  });
}

async function captureOptionalCommand(command, args) {
  try {
    return await captureCommand(command, args);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function pickJoinDirectory(env = process.env, platform = process.platform) {
  if (env.MARKLAB_PICK_DIR_FOR_TEST?.trim()) return resolve(env.MARKLAB_PICK_DIR_FOR_TEST);

  if (platform === 'darwin') {
    try {
      return resolve(await captureCommand('osascript', [
        '-e',
        'POSIX path of (choose folder with prompt "Choose where MarkLab should create the shared Markdown file")',
      ]));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/User canceled|cancelled|canceled/u.test(message)) throw new Error('Folder selection cancelled.');
      throw new Error(`Unable to open the folder picker. Re-run with --dir <folder>. ${message}`);
    }
  }

  if (platform === 'win32') {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
      '$dialog.Description = "Choose where MarkLab should create the shared Markdown file"',
      '$dialog.ShowNewFolderButton = $true',
      'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) } else { exit 2 }',
    ].join('; ');
    try {
      return resolve(await captureCommand('powershell.exe', ['-NoProfile', '-STA', '-Command', script]));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/exited with code 2/u.test(message)) throw new Error('Folder selection cancelled.');
      throw new Error(`Unable to open the folder picker. Re-run with --dir <folder>. ${message}`);
    }
  }

  for (const candidate of [
    { command: 'zenity', args: ['--file-selection', '--directory', '--title=Choose where MarkLab should create the shared Markdown file'] },
    { command: 'kdialog', args: ['--getexistingdirectory', '.', 'Choose where MarkLab should create the shared Markdown file'] },
  ]) {
    const picked = await captureOptionalCommand(candidate.command, candidate.args);
    if (picked) return resolve(picked);
  }

  throw new Error('--pick-dir requires macOS Finder, Windows PowerShell, zenity, or kdialog. Re-run with --dir <folder>.');
}

export function ensurePackagedRuntimeWorkspaceLinks(activeRepoRoot = repoRoot, runtimeRoot = packagedRuntimeRoot) {
  if (activeRepoRoot !== runtimeRoot) return false;
  const scopeRoot = resolve(runtimeRoot, 'node_modules/@marklab');
  mkdirSync(scopeRoot, { recursive: true });

  for (const name of ['shared', 'markdown', 'collab-editor']) {
    const linkPath = resolve(scopeRoot, name);
    const target = `../../packages/${name}`;
    try {
      const existing = lstatSync(linkPath);
      if (existing.isSymbolicLink() && readlinkSync(linkPath) === target) continue;
      rmSync(linkPath, { recursive: true, force: true });
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
    symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  }

  return true;
}

function spawnPnpm(argsToRun, env, stdio = 'inherit') {
  ensurePackagedRuntimeWorkspaceLinks();
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

function localRelayConfig(apiPort, webPort) {
  return loadRelayConfig({ apiPort, webPort, defaultPublicRelay: true });
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
  const relayConfig = input.relayConfig ?? localRelayConfig(input.apiPort, input.webPort);
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
        MARKLAB_PUBLIC_API_URL: relayConfig.publicApiUrl,
        MARKLAB_PUBLIC_WEB_URL: relayConfig.publicWebUrl,
        MARKLAB_PUBLIC_RELAY_WS_URL: relayConfig.publicRelayWebSocketUrl,
        MARKLAB_RELAY_WS_URL: relayConfig.relayWebSocketUrl,
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
  await waitForSessionExit(session);
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
  if (!response.ok) {
    throw new AgentCommandError('relay_unavailable', 'Unable to create relay link.', {
      status: response.status,
      body,
    });
  }
  return JSON.parse(body);
}

async function shareForeground(file) {
  const markdownPath = await resolveMarkdownFile(file);
  const { apiPort, webPort } = await chooseLocalPorts();
  const token = randomBytes(24).toString('base64url');
  const relayConfig = localRelayConfig(apiPort, webPort);
  const session = serveLocalFile({ markdownPath, apiPort, webPort, token, enableRelay: true, relayConfig });
  await session.waitReady();
  const created = await createLocalRelayLink(session.apiUrl, token, 'edit');
  console.log(`Sharing ${markdownPath}`);
  console.log(`Edit link: ${created.url}`);
  console.log('Host online means the MarkLab daemon is running and connected.');
  console.log('This foreground share stops if this terminal closes. Closing the browser tab does not stop hosting.');
  console.log(`Local browser URL: ${session.localUrl}`);
  openBrowser(session.localUrl);
  await waitForSessionExit(session);
}

async function ensureBackgroundDaemon(file) {
  const markdownPath = await resolveMarkdownFile(file);
  return startBackgroundDaemon(markdownPath);
}

async function shareJsonCommand(file, options = {}) {
  const { daemon, reused } = await ensureBackgroundDaemon(file);
  if (options.daemonOnly) {
    writeAgentJson(agentSuccess({
      path: daemon.realpath,
      reusedDaemon: reused,
      browserUrl: daemon.localUrl ?? null,
      apiUrl: daemon.apiUrl,
    }));
    return;
  }
  const created = await createLocalRelayLink(daemon.apiUrl, daemon.token, 'edit');
  writeAgentJson(agentSuccess({
    path: daemon.realpath,
    reusedDaemon: reused,
    browserUrl: daemon.localUrl ?? null,
    relayRoomId: created.relayRoomId,
    grantId: created.grantId,
    role: created.role,
    url: created.url,
    expiresAt: created.expiresAt ?? null,
    createdAt: created.createdAt ?? null,
  }));
}

async function openBackground(file) {
  const markdownPath = await resolveMarkdownFile(file);
  const { daemon, reused } = await startBackgroundDaemon(markdownPath);
  if (reused) {
    console.log(`MarkLab is already watching ${markdownPath}`);
    console.log(`Browser URL: ${daemon.localUrl}`);
    console.log(`Stop with: marklab stop ${markdownPath}`);
    openBrowser(daemon.localUrl);
    return;
  }

  console.log(`Opened ${markdownPath}`);
  console.log(`Browser URL: ${daemon.localUrl}`);
  console.log('Sync is running in the background.');
  console.log(`Stop with: marklab stop ${markdownPath}`);
  openBrowser(daemon.localUrl);
}

async function startBackgroundDaemon(markdownPath, options = {}) {
  const registryPath = options.registryPath ?? defaultDaemonRegistryPath();
  const existing = await findDaemonByRealpath(markdownPath, registryPath);
  if (existing) return { daemon: existing, reused: true };

  const { apiPort, webPort } = await chooseLocalPorts();
  const token = randomBytes(24).toString('base64url');
  const { apiUrl, webUrl, localUrl } = buildLocalUrls(apiPort, webPort, token);
  const relayConfig = localRelayConfig(apiPort, webPort);
  const child = spawn(process.execPath, [cliPath, '__serve', markdownPath, '--api-port', String(apiPort), '--web-port', String(webPort), '--token', token], {
    cwd: repoRoot,
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      MARKLAB_LOCAL_DAEMON_REGISTRY_PATH: registryPath,
      MARKLAB_LOCAL_METADATA_PATH: defaultMetadataPath(),
      ...(relayConfig.mode === 'production'
        ? {
            MARKLAB_PUBLIC_API_URL: relayConfig.publicApiUrl,
            MARKLAB_PUBLIC_WEB_URL: relayConfig.publicWebUrl,
            MARKLAB_PUBLIC_RELAY_WS_URL: relayConfig.publicRelayWebSocketUrl,
            MARKLAB_RELAY_WS_URL: relayConfig.relayWebSocketUrl,
          }
        : {}),
      ...(options.relayJoin
        ? {
            MARKLAB_RELAY_ROOM_ID: options.relayJoin.relayRoomId,
            MARKLAB_RELAY_TOKEN: options.relayJoin.token,
            MARKLAB_RELAY_CLIENT_ID: options.relayJoin.clientId,
            MARKLAB_RELAY_DISPLAY_NAME: options.relayJoin.displayName,
            MARKLAB_RELAY_WS_URL: options.relayJoin.wsUrl,
          }
        : {}),
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
    return { daemon: registered.existing, reused: true };
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

  return { daemon: entry, reused: false };
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

async function statusCommand(input) {
  if (input.json) {
    writeAgentJson(await buildAgentStatus({ file: input.file }));
    return;
  }
  await printStatus();
}

async function requireRunningDaemon(file) {
  try {
    return await findWatchedDaemon(file);
  } catch (error) {
    if (error instanceof AgentCommandError && error.code === 'file_not_watched') {
      throw new AgentCommandError('daemon_not_running', 'No running MarkLab daemon found for that file. Start one with marklab open <file.md> --background.', error.details);
    }
    throw error;
  }
}

function printHumanShareState(state) {
  console.log(`Relay room: ${state.relayRoomId ?? 'not shared'}`);
  console.log(`Host: ${state.hostOnline ? 'online' : 'offline'}`);
  for (const link of state.links ?? []) {
    console.log(`${link.role} ${link.grantId} sessions=${link.activeSessionCount}`);
  }
}

async function shareStateCommand(input) {
  const daemon = await requireRunningDaemon(input.file);
  const state = await fetchLocalJson(daemon, '/api/local/share-state', {
    errorCode: 'relay_unavailable',
    errorMessage: 'Unable to read share state.',
  });
  if (input.json) {
    writeAgentJson(agentSuccess({ path: daemon.realpath, shareState: state }));
    return;
  }
  printHumanShareState(state);
}

async function createLinkCommand(input) {
  if (input.role !== 'view' && input.role !== 'edit') throw new AgentCommandError('invalid_target', '--role must be view or edit');
  const daemon = await requireRunningDaemon(input.file);
  const created = await createLocalRelayLink(daemon.apiUrl, daemon.token, input.role);
  if (input.json) {
    writeAgentJson(agentSuccess({
      path: daemon.realpath,
      role: created.role,
      grantId: created.grantId,
      relayRoomId: created.relayRoomId,
      url: created.url,
      expiresAt: created.expiresAt ?? null,
      createdAt: created.createdAt ?? null,
    }));
    return;
  }
  console.log(created.url);
}

async function revokeLinkCommand(input) {
  const daemon = await requireRunningDaemon(input.file);
  const response = await fetch(`${daemon.apiUrl}/api/local/access-grants/${encodeURIComponent(input.grantId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${daemon.token}` },
  });
  if (!response.ok) {
    throw new AgentCommandError('relay_unavailable', 'Unable to revoke relay link.', {
      path: daemon.realpath,
      status: response.status,
      body: await response.text(),
    });
  }
  if (input.json) {
    writeAgentJson(agentSuccess({ path: daemon.realpath, grantId: input.grantId, revoked: true }));
    return;
  }
  console.log(`Revoked ${input.grantId}`);
}

async function recentCommand(input) {
  const result = await listRecentFiles();
  if (input.json) {
    writeAgentJson(result);
    return;
  }
  if (result.files.length === 0) {
    console.log('No recent MarkLab files.');
    return;
  }
  for (const file of result.files) {
    console.log(`${file.path} (${file.syncState})`);
  }
}

async function waitCommand(input) {
  const result = await waitForSync(input);
  if (input.json) {
    writeAgentJson(result);
    return;
  }
  console.log(`${result.path} is synced (${result.observedHash}, waited ${result.waitedMs}ms).`);
}

async function saveVersionCommand(input) {
  if (!input.file) throw new AgentCommandError('invalid_target', 'save-version requires a Markdown file path.');
  if (!input.message) throw new AgentCommandError('invalid_target', 'save-version requires --message.');
  const daemon = await requireRunningDaemon(input.file);
  const saved = await fetchLocalJson(daemon, '/api/local/versions/manual-save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'agent', message: input.message }),
    errorCode: 'daemon_not_running',
    errorMessage: 'Unable to save a local version.',
  });
  const result = agentSuccess({
    path: daemon.realpath,
    source: 'agent',
    message: input.message,
    created: Boolean(saved?.created),
    versionId: saved?.versionId ?? null,
    versionNumber: Number.isInteger(saved?.versionNumber) ? saved.versionNumber : null,
    observedHash: saved?.hash ?? null,
  });
  if (input.json) {
    writeAgentJson(result);
    return;
  }
  console.log(`Saved version ${result.versionId ?? '(unknown)'} for ${daemon.realpath}`);
}

async function versionsCommand(input) {
  if (!input.file) throw new AgentCommandError('invalid_target', 'versions requires a Markdown file path.');
  const daemon = await requireRunningDaemon(input.file);
  const versions = await fetchLocalJson(daemon, '/api/local/versions', {
    errorCode: 'daemon_not_running',
    errorMessage: 'Unable to list local versions.',
  });
  const result = agentSuccess({ path: daemon.realpath, versions: versions?.versions ?? [] });
  if (input.json) {
    writeAgentJson(result);
    return;
  }
  for (const version of result.versions) {
    console.log(`${version.versionNumber} ${version.versionId} ${version.operation} ${version.hash}`);
  }
}

async function conflictCommand(input) {
  if (!input.file) throw new AgentCommandError('invalid_target', 'conflict requires a Markdown file path.');
  const daemon = await requireRunningDaemon(input.file);
  const documentState = await readLocalDocument(daemon);
  const conflictState = await readLocalConflictState(daemon);
  const conflictPackage = conflictState?.conflict && typeof conflictState.conflict === 'object' ? conflictState.conflict : null;
  const message =
    conflictPackage?.status === 'open'
      ? 'Relay reconnect conflict. Review needed before syncing resumes.'
      : conflictState?.message ?? (typeof conflictState?.conflict === 'string' ? conflictState.conflict : null) ?? conflictState?.reason ?? documentState.conflict ?? null;
  if (!conflictState && !message) {
    throw new AgentCommandError('conflict_unavailable', 'Conflict review state is not available for this file yet.', {
      path: daemon.realpath,
    });
  }
  const result = agentSuccess({
    path: daemon.realpath,
    hasConflict: Boolean(message || conflictState?.hasConflict || conflictState?.open),
    syncState: message ? 'paused' : 'synced',
    conflict: message
      ? {
          message,
          source: conflictState ? 'conflict-api' : 'local-document',
          state: conflictPackage ?? conflictState ?? null,
        }
      : null,
    nextStep: message
      ? 'Stop editing the watched file and ask the user to resolve the conflict in MarkLab, or write a separate resolved draft.'
      : 'No open conflict was reported.',
  });
  if (input.json) {
    writeAgentJson(result);
    return;
  }
  console.log(result.conflict?.message ?? result.nextStep);
}

async function doctorCommand(input) {
  const result = await runDoctor(input);
  if (input.json) {
    writeAgentJson(result);
    return;
  }
  printDoctorHuman(result);
}

async function agentCommand(input) {
  if (input.agentCommand === 'instructions') {
    const result = await readAgentInstructions(input.target);
    if (input.json) {
      writeAgentJson(agentSuccess(result));
      return;
    }
    process.stdout.write(result.instructions);
    if (!result.instructions.endsWith('\n')) process.stdout.write('\n');
    return;
  }

  if (input.agentCommand === 'install') {
    const result = await installAgentInstructions(input);
    if (input.json) {
      writeAgentJson(result);
      return;
    }
    console.log(`Installed ${result.target} instructions at ${result.path}`);
    return;
  }

  throw new AgentCommandError('invalid_target', 'agent requires instructions or install.');
}

async function forbiddenAgentWriteCommand(input) {
  throw new AgentCommandError('forbidden_agent_write', `marklab ${input.command} is forbidden for agents. Edit the local Markdown file directly, then use marklab wait/save-version/status for coordination.`);
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
  const { apiUrl } = buildRelayJoinUrls(link);
  return {
    relayRoomId: decodeURIComponent(match[1]),
    token,
    apiUrl,
    suggestedFilename: url.searchParams.get('filename') || url.searchParams.get('name') || null,
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

  if (input.file && (input.dir || input.pickDir)) throw new Error('join accepts either a target file, --dir, or --pick-dir, not more than one.');
  if (input.dir && input.pickDir) throw new Error('join accepts either --dir or --pick-dir, not both.');

  let target;
  if (input.dir || input.pickDir) {
    const directory = resolve(input.dir ?? await pickJoinDirectory());
    if (!existsSync(directory)) {
      if (!input.createDir) throw new Error(`${directory} does not exist. Re-run with --create-dir to create it.`);
      await import('node:fs/promises').then(({ mkdir }) => mkdir(directory, { recursive: true }));
    } else {
      const { stat } = await import('node:fs/promises');
      const directoryStat = await stat(directory);
      if (!directoryStat.isDirectory()) throw new Error(`${directory} is not a directory.`);
    }
    target = resolve(directory, safeRelayJoinFilename(input.name ?? link.suggestedFilename ?? access.suggestedFilename ?? 'shared-notes.md'));
  } else if (input.file) {
    target = resolve(input.file);
  } else {
    throw new Error('join requires a target file or --dir');
  }

  if (existsSync(target)) {
    if (input.background) {
      const watchedTarget = await findDaemonByRealpath(await canonicalRealpath(target));
      if (watchedTarget) throw new Error(`MarkLab is already watching ${watchedTarget.realpath}. Stop it before joining this relay link.`);
    }
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
  const markdownPath = await canonicalRealpath(target);
  const { wsUrl } = buildRelayJoinUrls(input.link);
  const relayJoin = {
    relayRoomId: link.relayRoomId,
    token: link.token,
    clientId: `mirror_${randomBytes(12).toString('base64url')}`,
    displayName: input.name ?? basename(markdownPath),
    wsUrl,
  };

  if (input.background) {
    const { daemon, reused } = await startBackgroundDaemon(markdownPath, { relayJoin });
    console.log(`Joined relay room ${link.relayRoomId}`);
    console.log(`Local mirror file: ${markdownPath}`);
    console.log(`Local browser URL: ${daemon.localUrl}`);
    if (reused) {
      console.log('MarkLab was already watching this mirror file.');
    } else {
      console.log('Sync is running in the background.');
    }
    console.log(`Stop with: marklab stop ${markdownPath}`);
    openBrowser(daemon.localUrl);
    return;
  }

  const { apiPort, webPort } = await chooseLocalPorts();
  const localToken = randomBytes(24).toString('base64url');
  const session = serveLocalFile({
    markdownPath,
    apiPort,
    webPort,
    token: localToken,
    relayJoin,
  });
  await session.waitReady();
  console.log(`Joined relay room ${link.relayRoomId}`);
  console.log(`Local mirror file: ${markdownPath}`);
  console.log(`Local browser URL: ${session.localUrl}`);
  await waitForSessionExit(session);
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
  await waitForSessionExit(session);
}

export async function main(argv = process.argv.slice(2)) {
  const input = parseCliArgs(argv);
  if (input.forbiddenAgentWrite) {
    await forbiddenAgentWriteCommand(input);
    return;
  }

  if (input.command === 'open' && input.file) {
    if (input.background) await openBackground(input.file);
    else await openForeground(input.file);
    return;
  }

  if (input.command === 'share' && input.file) {
    if (input.json) await shareJsonCommand(input.file, { daemonOnly: input.daemonOnly });
    else await shareForeground(input.file);
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

  if (input.command === 'recent') {
    await recentCommand(input);
    return;
  }

  if (input.command === 'wait') {
    await waitCommand(input);
    return;
  }

  if (input.command === 'save-version') {
    await saveVersionCommand(input);
    return;
  }

  if (input.command === 'versions') {
    await versionsCommand(input);
    return;
  }

  if (input.command === 'conflict') {
    await conflictCommand(input);
    return;
  }

  if (input.command === 'doctor') {
    await doctorCommand(input);
    return;
  }

  if (input.command === 'agent') {
    await agentCommand(input);
    return;
  }

  if (input.command === 'join') {
    await joinCommand(input);
    return;
  }

  if (input.command === 'status') {
    await statusCommand(input);
    return;
  }

  if (input.command === 'stop' && (input.all || input.file)) {
    await stopCommand(input);
    return;
  }

  if (input.command === 'help') {
    printCommandUsage(input.topic);
    return;
  }

  if (input.command === '__serve') {
    await serveCommand(input);
    return;
  }

  if (input.json) {
    throw new AgentCommandError('invalid_target', `Invalid marklab command or target: ${input.command}`);
  }
  printUsage();
  process.exit(input.command === 'help' ? 0 : 2);
}

function isDirectCliInvocation() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  }
}

if (isDirectCliInvocation()) {
  void main().catch((error) => {
    const wantsJson = process.argv.slice(2).includes('--json');
    if (wantsJson) {
      const exitCode = writeAgentError(error, { json: true, fallbackCode: 'invalid_target' });
      process.exit(exitCode);
    }
    if (error instanceof AgentCommandError) {
      console.error(error.message);
      process.exit(error.exitCode);
    }
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
