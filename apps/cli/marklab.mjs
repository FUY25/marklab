#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readlinkSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import http from 'node:http';
import net from 'node:net';
import { basename, dirname, join, resolve, sep } from 'node:path';
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
const legacyCliOptInEnv = 'MARKLAB_ENABLE_LEGACY_CLI';
const nativeRelayCommands = new Set(['open', 'share', 'status', 'wait', 'conflict', 'doctor']);
const legacyLocalDaemonCommands = new Set([
  'open',
  'share',
  'share-state',
  'create-link',
  'revoke-link',
  'join',
  'status',
  'recent',
  'wait',
  'save-version',
  'versions',
  'conflict',
  'doctor',
  'agent',
  'stop',
  '__serve',
]);
const packagedLegacyRuntimeCommands = new Set([
  'open',
  'share',
  'share-state',
  'create-link',
  'revoke-link',
  'join',
  'status',
  'recent',
  'wait',
  'save-version',
  'versions',
  'conflict',
  '__serve',
]);

export function printUsage() {
  console.log(`Usage:
  marklab CLI local-daemon commands are legacy and disabled by default.
  Use MarkLab.app with the hosted /collab relay/Y-Sweet pilot.
  For archived compatibility testing only, set ${legacyCliOptInEnv}=1.

  marklab open <file.md> [--background]
  marklab share <file.md> --edit [--json]
  marklab share <file.md> --view [--json]
  marklab join <https://.../collab?...mode=edit> [--json]
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
  marklab conflict <file.md> [--use-shared|--use-local|--resolve-file <file.md>] --json
  marklab doctor [file.md] --json
  marklab agent instructions --target <codex|claude|cursor>
  marklab agent install --target codex --write AGENTS.md [--force]
  marklab stop <file.md>
  marklab stop --all`);
}

export function legacyCliEnabled(env = process.env) {
  return env[legacyCliOptInEnv] === '1';
}

export function legacyCliRequired(command) {
  return legacyLocalDaemonCommands.has(command);
}

function assertLegacyCliEnabled(input, env = process.env) {
  if (input.command === 'join' && input.link && isCollabURL(input.link)) {
    parseHostedCollabLink(input.link);
    return;
  }
  if (nativeRelayCommands.has(input.command) && !legacyCliEnabled(env)) return;
  if (!legacyCliRequired(input.command) || legacyCliEnabled(env)) return;
  throw new AgentCommandError(
    'legacy_cli_disabled',
    `marklab ${input.command} is disabled by default because this CLI drives the archived local-daemon workflow. Use MarkLab.app with the hosted /collab relay/Y-Sweet pilot. Set ${legacyCliOptInEnv}=1 only for archived compatibility testing.`,
    { command: input.command, optInEnv: legacyCliOptInEnv },
  );
}

export function assertLegacyCliRuntimeAvailable(input, env = process.env, activeRepoRoot = repoRoot) {
  if (!legacyCliEnabled(env)) return;
  if (!packagedLegacyRuntimeCommands.has(input.command)) return;
  if (input.command === 'join' && input.link && isCollabURL(input.link)) return;
  const hasLegacyAppRuntime = existsSync(resolve(activeRepoRoot, 'apps/api')) && existsSync(resolve(activeRepoRoot, 'apps/web'));
  if (basename(activeRepoRoot) !== 'runtime' && hasLegacyAppRuntime) return;

  throw new AgentCommandError(
    'legacy_cli_disabled',
    'The packaged @marklab/cli no longer bundles the archived daemon runtime dependencies. Use the default MarkLab.app hosted /collab path, or run archived daemon compatibility tests from a repository checkout with workspace dependencies installed.',
    { command: input.command, runtimeRoot: activeRepoRoot, optInEnv: legacyCliOptInEnv },
  );
}

export function printCommandUsage(command) {
  if (command === 'open') {
    console.log(`Usage:
  marklab open <file.md>
  marklab open <file.md> --background

Open a local Markdown file in MarkLab.app. The --background form is archived daemon compatibility and requires ${legacyCliOptInEnv}=1.`);
    return;
  }
  if (command === 'share') {
    console.log(`Usage:
  marklab share <file.md> --edit [--json]
  marklab share <file.md> --view [--json]

Ask MarkLab.app to start or reuse native sharing in the background, create an edit/view link, copy it to the clipboard, and print it. This command does not mint a hidden daemon relay link.`);
    return;
  }
  if (command === 'join') {
    console.log(`Usage:
  marklab join <https://.../collab?...mode=edit> [--json]
  marklab join <edit-link> <file.md>
  marklab join <edit-link> --dir <dir> [--name <file.md>] [--create-dir] [--background]
  marklab join <edit-link> --pick-dir [--background]

Open a hosted /collab edit link in MarkLab.app. Archived /relay links still require ${legacyCliOptInEnv}=1 and use the old local mirror daemon path.`);
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
      json,
      background: rest.includes('--background'),
    };
  }

  if (command === 'share') {
    const file = positionalArgs(rest)[0] ?? null;
    const wantsEdit = rest.includes('--edit');
    const wantsView = rest.includes('--view');
    return {
      command,
      file,
      json,
      daemonOnly: rest.includes('--daemon-only'),
      shareRole: wantsEdit && wantsView ? 'invalid' : wantsEdit ? 'edit' : wantsView ? 'view' : null,
    };
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
      json,
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
    const file = positionalArgs(rest, ['--resolve-file'])[0] ?? null;
    return {
      command,
      file,
      json,
      resolveFile: parseFlagValue(rest, '--resolve-file'),
      resolveFileFlagPresent: rest.includes('--resolve-file'),
      useLocal: rest.includes('--use-local'),
      useShared: rest.includes('--use-shared'),
    };
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

function nativeJoinScheme(env = process.env) {
  const scheme = (env.MARKLAB_APP_URL_SCHEME?.trim() || 'marklab').replace(/:.*$/u, '');
  if (!/^[a-z][a-z0-9+.-]*$/iu.test(scheme)) {
    throw new AgentCommandError('invalid_config', 'MARKLAB_APP_URL_SCHEME must be a valid URL scheme.', { scheme });
  }
  return scheme;
}

function nativeAppBundlePath(env = process.env) {
  return env.MARKLAB_APP_PATH?.trim() || env.MARKLAB_APP_BUNDLE_PATH?.trim() || null;
}

function nativeAppName(env = process.env) {
  return env.MARKLAB_APP_NAME?.trim() || 'MarkLab';
}

function runOpener(command, args, timeoutMs = 10_000) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      resolveRun({ exitCode: null, signal: 'SIGTERM', stderr, timedOut: true });
    }, timeoutMs);

    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveRun({ exitCode: null, signal: null, stderr, error: error instanceof Error ? error.message : String(error) });
    });
    child.once('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveRun({ exitCode, signal, stderr });
    });
  });
}

async function runNativeOpen(command, args, action) {
  const result = await runOpener(command, args);
  if (result.exitCode === 0) return true;
  throw new AgentCommandError('native_launch_failed', `Failed to ${action} in MarkLab.app.`, {
    command,
    args,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: Boolean(result.timedOut),
    stderr: String(result.stderr ?? '').slice(0, 2000),
    error: result.error,
  });
}

async function openExternalURL(url, env = process.env) {
  if (process.env.MARKLAB_NO_OPEN === 'true') return false;
  if (env.MARKLAB_OPEN_COMMAND_FOR_TEST) {
    return runNativeOpen(env.MARKLAB_OPEN_COMMAND_FOR_TEST, [url], 'open the shared link');
  }
  if (process.platform === 'darwin') {
    const appPath = nativeAppBundlePath(env);
    const args = appPath ? ['-a', resolve(appPath), url] : ['-a', nativeAppName(env), url];
    return runNativeOpen('open', args, 'open the shared link');
  }
  if (process.platform === 'win32') {
    return runNativeOpen('cmd', ['/c', 'start', '', url], 'open the shared link');
  }
  return runNativeOpen('xdg-open', [url], 'open the shared link');
}

async function openExternalFile(filePath, env = process.env) {
  if (process.env.MARKLAB_NO_OPEN === 'true') return false;
  if (env.MARKLAB_OPEN_COMMAND_FOR_TEST) {
    return runNativeOpen(env.MARKLAB_OPEN_COMMAND_FOR_TEST, [filePath], 'open the file');
  }
  if (process.platform === 'darwin') {
    const appPath = nativeAppBundlePath(env);
    const args = ['-a', appPath ? resolve(appPath) : nativeAppName(env), filePath];
    return runNativeOpen('open', args, 'open the file');
  }
  if (process.platform === 'win32') {
    return runNativeOpen('cmd', ['/c', 'start', '', filePath], 'open the file');
  }
  return runNativeOpen('xdg-open', [filePath], 'open the file');
}

function nativeAppSupportDir(env = process.env) {
  if (env.MARKLAB_APP_SUPPORT_DIR?.trim()) return resolve(env.MARKLAB_APP_SUPPORT_DIR);
  return join(homedir(), 'Library', 'Application Support', 'MarkLab');
}

function nativeCliRequestTimeoutMs(env = process.env) {
  const configured = Number(env.MARKLAB_NATIVE_CLI_TIMEOUT_MS ?? 120000);
  return Number.isFinite(configured) && configured > 0 ? configured : 120000;
}

function nativeCliRequestPaths(requestId, env = process.env) {
  const appSupport = nativeAppSupportDir(env);
  return {
    appSupport,
    requestId,
    requestsDir: join(appSupport, 'cli-requests'),
    responsesDir: join(appSupport, 'cli-responses'),
    requestPath: join(appSupport, 'cli-requests', `${requestId}.json`),
    responsePath: join(appSupport, 'cli-responses', `${requestId}.json`),
  };
}

function nativeCliRequestId() {
  return `req_${Date.now().toString(36)}_${randomBytes(8).toString('base64url')}`;
}

async function writeNativeShareRequest({ markdownPath, role }, env = process.env) {
  const requestId = nativeCliRequestId();
  const paths = nativeCliRequestPaths(requestId, env);
  await mkdir(paths.requestsDir, { recursive: true });
  await mkdir(paths.responsesDir, { recursive: true });
  const request = {
    schemaVersion: 1,
    requestId,
    action: 'share',
    file: markdownPath,
    role,
    createdAt: new Date().toISOString(),
  };
  await writeFile(paths.requestPath, JSON.stringify(request, null, 2), { mode: 0o600 });
  return { ...paths, request };
}

async function waitForNativeShareResponse(responsePath, timeoutMs) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt <= timeoutMs) {
    try {
      return JSON.parse(await readFile(responsePath, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT') lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  if (lastError) {
    throw new AgentCommandError('native_share_failed', 'Unable to read native share response.', {
      responsePath,
      error: lastError instanceof Error ? lastError.message : String(lastError),
    });
  }
  throw new AgentCommandError('native_share_timeout', 'Timed out waiting for MarkLab.app to create the share link.', {
    responsePath,
    timeoutMs,
  });
}

async function openNativeCliRequest(requestId, env = process.env) {
  if (process.env.MARKLAB_NO_OPEN === 'true') return false;
  const argsForApp = ['--marklab-cli-request', requestId];
  if (env.MARKLAB_OPEN_COMMAND_FOR_TEST) {
    return runNativeOpen(env.MARKLAB_OPEN_COMMAND_FOR_TEST, argsForApp, 'process the native share request');
  }
  if (process.platform === 'darwin') {
    const appPath = nativeAppBundlePath(env);
    const args = appPath
      ? ['-gj', '-a', resolve(appPath), '--args', ...argsForApp]
      : ['-gj', '-a', nativeAppName(env), '--args', ...argsForApp];
    return runNativeOpen('open', args, 'process the native share request');
  }
  throw new AgentCommandError('native_launch_failed', 'Background native share requests require MarkLab.app on macOS.', {
    platform: process.platform,
  });
}

async function requestNativeShareLink({ markdownPath, role }, env = process.env) {
  const pending = await writeNativeShareRequest({ markdownPath, role }, env);
  let opened = false;
  let response;
  try {
    opened = await openNativeCliRequest(pending.requestId, env);
    response = await waitForNativeShareResponse(pending.responsePath, nativeCliRequestTimeoutMs(env));
  } catch (error) {
    await rm(pending.requestPath, { force: true });
    throw error;
  }
  if (response?.ok !== true) {
    throw new AgentCommandError(
      response?.code || 'native_share_failed',
      response?.message || 'MarkLab.app could not create the share link.',
      response?.details ?? { requestId: pending.requestId }
    );
  }
  return { ...response, opened: Boolean(response.opened ?? opened) };
}

async function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

function markdownHash(markdown) {
  return `sha256:${createHash('sha256').update(markdown).digest('hex')}`;
}

function nativeConflictFileName(filePath) {
  return `${Buffer.from(resolve(filePath), 'utf8')
    .toString('base64')
    .replaceAll('/', '_')
    .replaceAll('+', '-')
    .replaceAll('=', '')}.json`;
}

function summarizeNativeBinding(binding) {
  if (!binding) return null;
  return {
    docId: binding.docId ?? null,
    branchId: binding.branchId ?? null,
    mode: binding.mode ?? null,
    localDocId: binding.localDocId ?? null,
    appEditorURL: binding.appEditorURL ?? null,
    createdAt: binding.createdAt ?? null,
    updatedAt: binding.updatedAt ?? null,
    hasAccessToken: Boolean(binding.token),
  };
}

async function readNativeRelayState(file, env = process.env) {
  const markdownPath = await resolveMarkdownFile(file);
  const appSupport = nativeAppSupportDir(env);
  const [bindingsStore, baselinesStore, diskMarkdown] = await Promise.all([
    readJsonFile(join(appSupport, 'shared-document-bindings.json'), { bindings: {} }),
    readJsonFile(join(appSupport, 'projection-baselines.json'), { baselines: {} }),
    import('node:fs/promises').then(({ readFile }) => readFile(markdownPath, 'utf8')),
  ]);
  const candidates = [markdownPath, resolve(file)];
  const binding = candidates.map((candidate) => bindingsStore?.bindings?.[candidate]).find(Boolean) ?? null;
  const baseline = candidates.map((candidate) => baselinesStore?.baselines?.[candidate]).find(Boolean) ?? null;
  const conflictPath = join(appSupport, 'conflicts', nativeConflictFileName(markdownPath));
  const conflict = await readJsonFile(conflictPath, null);
  const observedHash = markdownHash(diskMarkdown);
  const hasOpenConflict = Boolean(conflict && (conflict.status ?? 'open') === 'open');
  const shared = Boolean(binding);
  let syncState = shared ? 'pending' : 'local';
  if (hasOpenConflict) syncState = 'conflict';
  else if (shared && baseline?.lastProjectedHash === observedHash) syncState = 'synced';
  return {
    path: markdownPath,
    appSupportDir: appSupport,
    shared,
    syncState,
    observedHash,
    docId: binding?.docId ?? null,
    branchId: binding?.branchId ?? null,
    binding: summarizeNativeBinding(binding),
    baseline: baseline
      ? {
          lastProjectedHash: baseline.lastProjectedHash ?? null,
          lastProviderStateFingerprint: baseline.lastProviderStateFingerprint ?? null,
          updatedAt: baseline.updatedAt ?? null,
        }
      : null,
    conflict: hasOpenConflict ? conflict : null,
  };
}

export function parseHostedCollabLink(link) {
  let url;
  try {
    url = new URL(link);
  } catch {
    throw new AgentCommandError('invalid_target', 'join requires a valid MarkLab /collab edit link.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AgentCommandError('invalid_target', 'join requires a hosted MarkLab /collab edit link.');
  }
  if (url.pathname !== '/collab') {
    throw new AgentCommandError('invalid_target', 'join requires a MarkLab /collab edit link.');
  }
  const docId = url.searchParams.get('docId');
  const branchId = url.searchParams.get('branchId');
  const token = url.searchParams.get('token');
  const mode = url.searchParams.get('mode') ?? 'edit';
  if (!docId) throw new AgentCommandError('invalid_target', 'join link is missing docId.');
  if (!branchId) throw new AgentCommandError('invalid_target', 'join link is missing branchId.');
  if (!token) throw new AgentCommandError('invalid_target', 'join link is missing token.');
  if (mode !== 'edit') throw new AgentCommandError('invalid_target', 'View links stay browser-only. Ask for an edit link to join in MarkLab.app.');
  return {
    url,
    docId,
    branchId,
    token,
    mode,
  };
}

export function isHostedCollabLink(link) {
  try {
    parseHostedCollabLink(link);
    return true;
  } catch {
    return false;
  }
}

function isCollabURL(link) {
  try {
    const url = new URL(link);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.pathname === '/collab';
  } catch {
    return false;
  }
}

export function buildNativeJoinDeepLink(link, env = process.env) {
  const parsed = parseHostedCollabLink(link);
  const deepLink = new URL(`${nativeJoinScheme(env)}://join`);
  deepLink.searchParams.set('url', parsed.url.toString());
  return deepLink.toString();
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

async function nativeOpenCommand(input) {
  if (!input.file) throw new AgentCommandError('invalid_target', 'open requires a Markdown file path.');
  if (input.background) {
    throw new AgentCommandError('invalid_target', 'open --background is archived daemon compatibility. Set MARKLAB_ENABLE_LEGACY_CLI=1 to use it.');
  }
  const markdownPath = await resolveMarkdownFile(input.file);
  const opened = await openExternalFile(markdownPath);
  const result = agentSuccess({
    path: markdownPath,
    action: 'open_native_file',
    opened,
    nextStep: opened
      ? 'MarkLab.app should open the local Markdown file.'
      : 'Open this file in MarkLab.app.',
  });
  if (input.json) {
    writeAgentJson(result);
    return;
  }
  console.log(opened ? `Opening ${markdownPath} in MarkLab.app.` : `Open ${markdownPath} in MarkLab.app.`);
}

async function nativeShareCommand(input) {
  if (!input.file) throw new AgentCommandError('invalid_target', 'share requires a Markdown file path.');
  if (input.shareRole !== 'edit' && input.shareRole !== 'view') {
    throw new AgentCommandError('invalid_target', input.shareRole === 'invalid'
      ? 'share accepts only one of --edit or --view.'
      : 'share requires --edit or --view.');
  }
  const markdownPath = await resolveMarkdownFile(input.file);
  const response = await requestNativeShareLink({ markdownPath, role: input.shareRole });
  const result = agentSuccess({
    action: response.action ?? 'native_share_link_created',
    path: markdownPath,
    file: response.file ?? markdownPath,
    role: response.role ?? input.shareRole,
    url: response.url,
    copied: Boolean(response.copied),
    docId: response.docId ?? null,
    branchId: response.branchId ?? null,
    grantId: response.grantId ?? null,
    opened: Boolean(response.opened),
    requestId: response.requestId ?? null,
  });
  if (input.json) {
    writeAgentJson(result);
    return;
  }
  console.log(result.url);
  if (result.copied) console.log('Link copied to clipboard.');
}

async function nativeStatusCommand(input) {
  if (!input.file) {
    const result = agentSuccess({
      model: 'native-relay',
      syncState: 'unknown',
      message: 'Pass a Markdown file path to inspect native relay state.',
    });
    if (input.json) {
      writeAgentJson(result);
      return;
    }
    console.log(result.message);
    return;
  }
  const state = await readNativeRelayState(input.file);
  const result = agentSuccess(state);
  if (input.json) {
    writeAgentJson(result);
    return;
  }
  console.log(`${state.path}`);
  console.log(`  Shared: ${state.shared ? 'yes' : 'no'}`);
  console.log(`  Sync state: ${state.syncState}`);
  if (state.docId) console.log(`  Document: ${state.docId}`);
  if (state.branchId) console.log(`  Branch: ${state.branchId}`);
}

async function nativeWaitCommand(input) {
  if (!input.file) throw new AgentCommandError('invalid_target', 'wait requires a Markdown file path.');
  if (!input.synced) throw new AgentCommandError('invalid_target', 'wait currently requires --synced.');
  const timeoutMs = Number.isFinite(input.timeoutMs) ? input.timeoutMs : 10000;
  const startedAt = Date.now();
  let latest;
  while (Date.now() - startedAt <= timeoutMs) {
    latest = await readNativeRelayState(input.file);
    if (latest.syncState === 'conflict') {
      throw new AgentCommandError('conflict_required', 'Native relay sync is paused on a conflict.', {
        path: latest.path,
        conflict: latest.conflict,
      });
    }
    if (latest.syncState === 'synced' || latest.syncState === 'local') {
      const result = agentSuccess({
        path: latest.path,
        syncState: latest.syncState,
        observedHash: latest.observedHash,
        waitedMs: Date.now() - startedAt,
      });
      if (input.json) {
        writeAgentJson(result);
        return;
      }
      console.log(`${latest.path} is ${latest.syncState} (${latest.observedHash}).`);
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new AgentCommandError('sync_timeout', 'Timed out waiting for native relay sync.', {
    path: latest?.path ?? resolve(input.file),
    syncState: latest?.syncState ?? 'unknown',
    observedHash: latest?.observedHash ?? null,
    timeoutMs,
  });
}

async function nativeConflictCommand(input) {
  if (!input.file) throw new AgentCommandError('invalid_target', 'conflict requires a Markdown file path.');
  if (input.useLocal || input.useShared || input.resolveFile) {
    throw new AgentCommandError('invalid_conflict_action', 'Native conflict resolution is handled in MarkLab.app. This CLI only reports conflict state.');
  }
  const state = await readNativeRelayState(input.file);
  const result = agentSuccess({
    path: state.path,
    hasConflict: Boolean(state.conflict),
    syncState: state.syncState,
    conflict: state.conflict,
    nextStep: state.conflict
      ? 'Resolve the conflict in MarkLab.app before continuing.'
      : 'No native relay conflict is open.',
  });
  if (input.json) {
    writeAgentJson(result);
    return;
  }
  console.log(state.conflict ? result.nextStep : 'No native relay conflict is open.');
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

function conflictSharedStateGuard(conflictPackage) {
  return {
    expectedSharedRevision: conflictPackage.expectedSharedRevision ?? conflictPackage.sharedRevision,
    expectedSharedHash: conflictPackage.expectedSharedHash ?? conflictPackage.sharedHash,
  };
}

async function conflictCommand(input) {
  if (!input.file) throw new AgentCommandError('invalid_target', 'conflict requires a Markdown file path.');
  if (input.resolveFileFlagPresent && !input.resolveFile) {
    throw new AgentCommandError('invalid_conflict_action', 'Provide a Markdown file path after --resolve-file.');
  }
  const selectedActions = [input.useShared, input.useLocal, Boolean(input.resolveFile)].filter(Boolean).length;
  if (selectedActions > 1) {
    throw new AgentCommandError('invalid_conflict_action', 'Choose only one conflict resolution action.');
  }
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
  if ((input.useShared || input.useLocal || input.resolveFile) && (!conflictPackage || conflictPackage.status !== 'open')) {
    throw new AgentCommandError('conflict_unavailable', 'No open conflict package is available to resolve.', {
      path: daemon.realpath,
    });
  }
  if (input.useShared && conflictPackage) {
    const sharedStateGuard = conflictSharedStateGuard(conflictPackage);
    const resolved = await fetchLocalJson(daemon, `/api/local/conflicts/${encodeURIComponent(conflictPackage.conflictId)}/use-shared`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sharedStateGuard),
      errorCode: 'conflict_resolution_failed',
      errorCodeByBody: { host_offline: 'host_offline' },
      errorMessage: 'Unable to keep the shared conflict version.',
      errorMessageByBody: { host_offline: 'The host is offline. Retry when the host returns.' },
    });
    const result = agentSuccess({
      path: daemon.realpath,
      syncState: 'synced',
      conflict: null,
      resolution: resolved,
      nextStep: 'Shared version applied. Run marklab wait --synced before continuing.',
    });
    if (input.json) {
      writeAgentJson(result);
      return;
    }
    console.log(result.nextStep);
    return;
  }
  if (input.useLocal && conflictPackage) {
    const sharedStateGuard = conflictSharedStateGuard(conflictPackage);
    const resolved = await fetchLocalJson(daemon, `/api/local/conflicts/${encodeURIComponent(conflictPackage.conflictId)}/use-local`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sharedStateGuard),
      errorCode: 'conflict_resolution_failed',
      errorCodeByBody: { host_offline: 'host_offline' },
      errorMessage: 'Unable to publish the local conflict version.',
      errorMessageByBody: { host_offline: 'The host is offline. Retry when the host returns.' },
    });
    const result = agentSuccess({
      path: daemon.realpath,
      syncState: 'synced',
      conflict: null,
      resolution: resolved,
      nextStep: 'Local version applied. Run marklab wait --synced before continuing.',
    });
    if (input.json) {
      writeAgentJson(result);
      return;
    }
    console.log(result.nextStep);
    return;
  }
  if (input.resolveFile && conflictPackage) {
    const { readFile } = await import('node:fs/promises');
    const markdown = await readFile(resolve(input.resolveFile), 'utf8');
    const sharedStateGuard = conflictSharedStateGuard(conflictPackage);
    const resolved = await fetchLocalJson(daemon, `/api/local/conflicts/${encodeURIComponent(conflictPackage.conflictId)}/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        markdown,
        ...sharedStateGuard,
      }),
      errorCode: 'conflict_resolution_failed',
      errorCodeByBody: { host_offline: 'host_offline' },
      errorMessage: 'Unable to apply the resolved conflict Markdown.',
      errorMessageByBody: { host_offline: 'The host is offline. Retry when the host returns.' },
    });
    const result = agentSuccess({
      path: daemon.realpath,
      syncState: 'synced',
      conflict: null,
      resolution: resolved,
      nextStep: 'Resolved Markdown applied. Run marklab wait --synced before continuing.',
    });
    if (input.json) {
      writeAgentJson(result);
      return;
    }
    console.log(result.nextStep);
    return;
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
  throw new AgentCommandError('forbidden_agent_write', `marklab ${input.command} is forbidden for agents. Edit the local Markdown file directly, then use marklab wait, marklab status, and marklab conflict for coordination.`);
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
  if (isCollabURL(input.link)) {
    const deepLink = buildNativeJoinDeepLink(input.link);
    const opened = await openExternalURL(deepLink);
    if (input.json) {
      writeAgentJson(agentSuccess({
        link: input.link,
        nativeJoinUrl: deepLink,
        opened,
        nextStep: opened
          ? 'MarkLab.app should prompt for a local Markdown file.'
          : 'Open the nativeJoinUrl in MarkLab.app or paste the edit link into File > Open Shared Link.',
      }));
      return;
    }
    console.log('Opening MarkLab.app for shared document join.');
    console.log(`Native join URL: ${deepLink}`);
    if (!opened) {
      console.log('MARKLAB_NO_OPEN=true; paste the edit link into File > Open Shared Link in MarkLab.app.');
    }
    return;
  }
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
  assertLegacyCliEnabled(input);
  assertLegacyCliRuntimeAvailable(input);

  if (!legacyCliEnabled() && input.command === 'open') {
    await nativeOpenCommand(input);
    return;
  }

  if (!legacyCliEnabled() && input.command === 'share') {
    await nativeShareCommand(input);
    return;
  }

  if (!legacyCliEnabled() && input.command === 'status') {
    await nativeStatusCommand(input);
    return;
  }

  if (!legacyCliEnabled() && input.command === 'wait') {
    await nativeWaitCommand(input);
    return;
  }

  if (!legacyCliEnabled() && input.command === 'conflict') {
    await nativeConflictCommand(input);
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
