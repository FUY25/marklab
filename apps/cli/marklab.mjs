#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  AgentCommandError,
  agentSuccess,
  writeAgentError,
  writeAgentJson,
} from './agent-json.mjs';
import { installAgentInstructions, readAgentInstructions } from './agent-instructions.mjs';
import { runDoctor, printDoctorHuman } from './doctor.mjs';

export function printUsage() {
  console.log(`Usage:
  marklab open <file.md> [--json]
  marklab share <file.md> --edit [--json]
  marklab share <file.md> --view [--json]
  marklab join <https://.../collab?...mode=edit> [--json]
  marklab join <edit-link> <file.md> [--json]
  marklab join <edit-link> --dir <dir> [--name <file.md>] [--create-dir] [--json]
  marklab join <edit-link> --pick-dir [--json]
  marklab status [file.md] [--json]
  marklab wait <file.md> --synced --timeout 10000 --json
  marklab conflict <file.md> --json
  marklab doctor [file.md] --json
  marklab agent instructions --target <codex|claude|cursor>
  marklab agent install --target codex --write AGENTS.md [--force]

This CLI controls the current MarkLab.app + hosted /collab pilot. The archived local daemon, /local, and /relay mirror commands have been removed.`);
}

export function printCommandUsage(command) {
  if (command === 'open') {
    console.log(`Usage:
  marklab open <file.md> [--json]

Open a local Markdown file in MarkLab.app.`);
    return;
  }
  if (command === 'share') {
    console.log(`Usage:
  marklab share <file.md> --edit [--json]
  marklab share <file.md> --view [--json]

Ask MarkLab.app to start or reuse hosted sharing, create an edit/view link, copy it to the clipboard, and print it.`);
    return;
  }
  if (command === 'join') {
    console.log(`Usage:
  marklab join <https://.../collab?...mode=edit> [--json]
  marklab join <edit-link> <file.md> [--json]
  marklab join <edit-link> --dir <dir> [--name <file.md>] [--create-dir] [--json]
  marklab join <edit-link> --pick-dir [--json]

Open a hosted /collab edit link in MarkLab.app. View links remain browser-only.`);
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
    return { command, file, json, background: rest.includes('--background') };
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

  if (command === 'status') {
    const file = positionalArgs(rest)[0] ?? null;
    return { command, file, json };
  }

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

  return { command: command ?? 'help', json };
}

function captureCommand(command, args) {
  return new Promise((resolveCapture, rejectCapture) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
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

async function writeNativeJoinRequest({ link, targetPath }, env = process.env) {
  const requestId = nativeCliRequestId();
  const paths = nativeCliRequestPaths(requestId, env);
  await mkdir(paths.requestsDir, { recursive: true });
  await mkdir(paths.responsesDir, { recursive: true });
  const request = {
    schemaVersion: 1,
    requestId,
    action: 'join',
    file: targetPath,
    role: 'edit',
    link,
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
    return runNativeOpen(env.MARKLAB_OPEN_COMMAND_FOR_TEST, argsForApp, 'process the native CLI request');
  }
  if (process.platform === 'darwin') {
    const appPath = nativeAppBundlePath(env);
    const args = appPath
      ? ['-gj', '-a', resolve(appPath), '--args', ...argsForApp]
      : ['-gj', '-a', nativeAppName(env), '--args', ...argsForApp];
    return runNativeOpen('open', args, 'process the native CLI request');
  }
  throw new AgentCommandError('native_launch_failed', 'Background native requests require MarkLab.app on macOS.', {
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
      response?.details ?? { requestId: pending.requestId },
    );
  }
  return { ...response, opened: Boolean(response.opened ?? opened) };
}

async function requestNativeJoin({ link, targetPath }, env = process.env) {
  const pending = await writeNativeJoinRequest({ link, targetPath }, env);
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
      response?.code || 'native_join_failed',
      response?.message || 'MarkLab.app could not join the shared document.',
      response?.details ?? { requestId: pending.requestId },
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

function providerVerificationConfig(binding, env = process.env) {
  const apiUrl = env.MARKLAB_CONTROL_PLANE_API_URL?.trim() || env.MARKLAB_PUBLIC_API_URL?.trim() || '';
  const bearerToken = env.MARKLAB_USER_TOKEN?.trim() || '';
  if (!apiUrl || !bearerToken || !binding?.docId || !binding?.branchId) return null;
  return {
    apiUrl: apiUrl.replace(/\/+$/u, ''),
    bearerToken,
    docId: binding.docId,
    branchId: binding.branchId,
  };
}

async function verifyNativeProviderExport(binding, observedHash, env = process.env) {
  const config = providerVerificationConfig(binding, env);
  if (!config) return null;
  const timeoutMs = Number(env.MARKLAB_NATIVE_PROVIDER_VERIFY_TIMEOUT_MS ?? 10000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 10000);
  try {
    const response = await fetch(
      `${config.apiUrl}/api/docs/${encodeURIComponent(config.docId)}/branches/${encodeURIComponent(config.branchId)}/export.md`,
      {
        headers: { Authorization: `Bearer ${config.bearerToken}` },
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      return { status: 'unavailable', httpStatus: response.status, exportedHash: null };
    }
    const markdown = await response.text();
    const exportedHash = markdownHash(markdown);
    return {
      status: exportedHash === observedHash ? 'verified' : 'pending',
      httpStatus: response.status,
      exportedHash,
    };
  } catch (error) {
    return {
      status: 'unavailable',
      httpStatus: null,
      exportedHash: null,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function resolveMarkdownFile(file) {
  if (!file) throw new AgentCommandError('invalid_target', 'Markdown file path is required.');
  const markdownPath = resolve(file);
  if (!existsSync(markdownPath)) throw new AgentCommandError('invalid_target', `File not found: ${markdownPath}`, { path: markdownPath });
  return realpath(markdownPath);
}

async function readNativeRelayState(file, env = process.env) {
  const markdownPath = await resolveMarkdownFile(file);
  const appSupport = nativeAppSupportDir(env);
  const [bindingsStore, baselinesStore, diskMarkdown] = await Promise.all([
    readJsonFile(join(appSupport, 'shared-document-bindings.json'), { bindings: {} }),
    readJsonFile(join(appSupport, 'projection-baselines.json'), { baselines: {} }),
    readFile(markdownPath, 'utf8'),
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
  const providerVerification = syncState === 'synced'
    ? await verifyNativeProviderExport(binding, observedHash, env)
    : null;
  if (providerVerification?.status === 'pending') syncState = 'provider_pending';
  else if (providerVerification?.status === 'unavailable') syncState = 'provider_unknown';
  return {
    path: markdownPath,
    appSupportDir: appSupport,
    shared,
    syncState,
    observedHash,
    providerVerification,
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
    suggestedFilename: url.searchParams.get('filename') || url.searchParams.get('name') || null,
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

export function buildNativeJoinDeepLink(link, env = process.env) {
  const parsed = parseHostedCollabLink(link);
  const deepLink = new URL(`${nativeJoinScheme(env)}://join`);
  deepLink.searchParams.set('url', parsed.url.toString());
  return deepLink.toString();
}

export function safeJoinFilename(name, fallback = 'shared-notes.md') {
  const candidate = String(name ?? '').trim();
  if (!candidate) return fallback;
  if (candidate.includes('/') || candidate.includes('\\')) {
    throw new AgentCommandError('invalid_target', '--name must be a Markdown filename, not a path');
  }
  const base = basename(candidate);
  return base.toLowerCase().endsWith('.md') ? base : `${base}.md`;
}

function safeHostedJoinFilename(name, docId) {
  return safeJoinFilename(name, `shared-${docId}.md`);
}

async function resolveHostedCollabJoinTarget(input, parsed) {
  if (input.file && (input.dir || input.pickDir)) throw new AgentCommandError('invalid_target', 'join accepts either a target file, --dir, or --pick-dir, not more than one.');
  if (input.dir && input.pickDir) throw new AgentCommandError('invalid_target', 'join accepts either --dir or --pick-dir, not both.');
  if (!input.file && !input.dir && !input.pickDir) return null;

  let target;
  if (input.dir || input.pickDir) {
    const directory = resolve(input.dir ?? await pickJoinDirectory());
    if (!existsSync(directory)) {
      if (!input.createDir) throw new AgentCommandError('invalid_target', `${directory} does not exist. Re-run with --create-dir to create it.`);
      await mkdir(directory, { recursive: true });
    } else {
      const directoryStat = await stat(directory);
      if (!directoryStat.isDirectory()) throw new AgentCommandError('invalid_target', `${directory} is not a directory.`);
    }
    target = resolve(directory, safeHostedJoinFilename(input.name ?? parsed.suggestedFilename, parsed.docId));
  } else {
    target = resolve(input.file);
    await mkdir(dirname(target), { recursive: true });
  }

  if (existsSync(target)) {
    const existing = await readFile(target, 'utf8');
    if (existing.length > 0) {
      if (input.cancel) return { cancelled: true, target };
      if (input.review) throw new AgentCommandError('invalid_target', 'Review conflict is not available for hosted app joins yet. No file was changed.');
      if (input.replace) {
        throw new AgentCommandError('invalid_target', 'Replace is not available for hosted app joins yet. Choose an empty file or empty folder target so MarkLab can bind the shared document safely.');
      }
      throw new AgentCommandError('invalid_target', 'Target file is non-empty. Choose an empty file, an empty folder target, or reopen the existing bound shared file in MarkLab.app.');
    }
  }
  return { cancelled: false, target };
}

async function nativeOpenCommand(input) {
  if (!input.file) throw new AgentCommandError('invalid_target', 'open requires a Markdown file path.');
  if (input.background) {
    throw new AgentCommandError('invalid_target', 'open --background was removed with the archived local daemon CLI. Use marklab open <file.md> to open the current MarkLab.app pilot.');
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
  if (input.daemonOnly) {
    throw new AgentCommandError('invalid_target', 'share --daemon-only was removed with the archived local daemon CLI. Use --edit or --view.');
  }
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
  if (input.useLocal || input.useShared || input.resolveFile || input.resolveFileFlagPresent) {
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

async function joinCommand(input) {
  if (!input.link) throw new AgentCommandError('invalid_target', 'join requires an edit link');
  const parsed = parseHostedCollabLink(input.link);
  const target = await resolveHostedCollabJoinTarget(input, parsed);
  if (target?.cancelled) {
    if (input.json) {
      writeAgentJson(agentSuccess({ cancelled: true, path: target.target }));
      return;
    }
    console.log('Join cancelled. No file was changed.');
    return;
  }
  if (target?.target) {
    const response = await requestNativeJoin({ link: input.link, targetPath: target.target });
    const result = agentSuccess({
      action: response.action ?? 'native_join_started',
      path: response.file ?? target.target,
      docId: response.docId ?? parsed.docId,
      branchId: response.branchId ?? parsed.branchId,
      opened: Boolean(response.opened),
      requestId: response.requestId ?? null,
      nextStep: 'MarkLab.app is syncing this shared document in the background.',
    });
    if (input.json) {
      writeAgentJson(result);
      return;
    }
    console.log(`Joined shared document ${result.docId}`);
    console.log(`Local Markdown file: ${result.path}`);
    console.log(result.nextStep);
    return;
  }

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
}

export async function main(argv = process.argv.slice(2)) {
  const input = parseCliArgs(argv);
  if (input.forbiddenAgentWrite) {
    await forbiddenAgentWriteCommand(input);
    return;
  }

  if (input.command === 'open') {
    await nativeOpenCommand(input);
    return;
  }

  if (input.command === 'share') {
    await nativeShareCommand(input);
    return;
  }

  if (input.command === 'join') {
    await joinCommand(input);
    return;
  }

  if (input.command === 'status') {
    await nativeStatusCommand(input);
    return;
  }

  if (input.command === 'wait') {
    await nativeWaitCommand(input);
    return;
  }

  if (input.command === 'conflict') {
    await nativeConflictCommand(input);
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

  if (input.command === 'help') {
    printCommandUsage(input.topic);
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
