import { spawn } from 'node:child_process';

export type MarkLabLinkRole = 'view' | 'edit';

export type MarkLabCliErrorCode =
  | 'cli_unavailable'
  | 'command_failed'
  | 'invalid_json'
  | 'timeout'
  | 'file_not_watched'
  | 'daemon_not_running'
  | 'sync_timeout'
  | 'sync_paused'
  | 'host_offline'
  | 'conflict_required'
  | 'conflict_unavailable'
  | 'relay_unavailable'
  | 'share_not_started'
  | 'forbidden_agent_write'
  | 'doctor_failed'
  | 'invalid_target';

export class MarkLabCliError extends Error {
  readonly code: MarkLabCliErrorCode;
  readonly details: unknown;
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(code: MarkLabCliErrorCode, message: string, options: { details?: unknown; exitCode?: number | null; stderr?: string } = {}) {
    super(message);
    this.name = 'MarkLabCliError';
    this.code = code;
    this.details = options.details;
    this.exitCode = options.exitCode ?? null;
    this.stderr = options.stderr ?? '';
  }
}

export interface CommandExecution {
  exitCode: number | null;
  signal: NodeJS.Signals | string | null;
  stdout: string;
  stderr: string;
  error?: NodeJS.ErrnoException;
  timedOut?: boolean;
}

export interface CommandExecutorOptions {
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

export type CommandExecutor = (command: string, args: string[], options: CommandExecutorOptions) => Promise<CommandExecution>;

export interface MarkLabStatusEntry {
  path: string;
  displayName: string;
  daemon: 'running' | 'stopped' | 'missing' | string;
  mode: 'local' | 'relay-host' | 'relay-mirror' | string;
  syncState: 'synced' | 'paused' | 'host_offline' | 'error' | string;
  browserUrl: string | null;
  pid: number | null;
  port: number | null;
  lastSyncAt: string | null;
  hasConflict: boolean;
  relayRoomId: string | null;
}

export interface MarkLabStatusResponse {
  ok: true;
  files: MarkLabStatusEntry[];
}

export interface MarkLabCreatedLinkResponse {
  ok: true;
  path: string;
  role: MarkLabLinkRole;
  grantId: string;
  relayRoomId: string;
  url: string;
  expiresAt: string | null;
  createdAt: string | null;
}

export interface MarkLabShareStateLink {
  role: MarkLabLinkRole | string;
  grantId: string;
  activeSessionCount?: number;
  canCopyExistingUrl?: boolean;
}

export interface MarkLabShareState {
  relayRoomId?: string | null;
  hostOnline?: boolean;
  sharedRevision?: number | null;
  links?: MarkLabShareStateLink[];
  mode?: string;
}

export interface MarkLabShareStateResponse {
  ok: true;
  path: string;
  shareState: MarkLabShareState;
}

interface JsonErrorResponse {
  ok: false;
  code?: MarkLabCliErrorCode;
  message?: string;
  details?: unknown;
}

export interface MarkLabCliAdapterOptions {
  command: string;
  relayUrlOverride?: string;
  timeoutMs?: number;
  executor?: CommandExecutor;
}

const DEFAULT_TIMEOUT_MS = 10000;

export function splitCommandLine(input: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  const chars = Array.from(input.trim());
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index];
    if (char === undefined) continue;
    if (char === '\\') {
      const next = chars[index + 1];
      if (next && shouldEscape(next, quote)) {
        current += next;
        index += 1;
      } else {
        current += char;
      }
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/u.test(char)) {
      if (current) {
        parts.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (quote) throw new MarkLabCliError('invalid_target', 'CLI command setting has an unmatched quote.');
  if (current) parts.push(current);
  return parts;
}

function shouldEscape(char: string, quote: '"' | "'" | null): boolean {
  if (quote) return char === quote;
  return char === '"' || char === "'" || /\s/u.test(char);
}

function commandParts(commandLine: string): string[] {
  const parts = splitCommandLine(commandLine);
  return parts.length > 0 ? parts : ['marklab'];
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, '');
}

export function relayEnvFromOverride(rawOverride: string | undefined): NodeJS.ProcessEnv {
  const override = rawOverride?.trim();
  if (!override) return {};

  let url: URL;
  try {
    url = new URL(override);
  } catch {
    throw new MarkLabCliError('invalid_target', 'Hosted relay URL override must be an absolute http:// or https:// URL.');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new MarkLabCliError('invalid_target', 'Hosted relay URL override must start with http:// or https://.');
  }

  url.hash = '';
  url.search = '';
  const normalizedPath = trimTrailingSlash(url.pathname === '/' ? '' : url.pathname);
  const basePath = normalizedPath.endsWith('/relay') ? trimTrailingSlash(normalizedPath.slice(0, -'/relay'.length)) : normalizedPath;
  const baseUrl = trimTrailingSlash(`${url.protocol}//${url.host}${basePath}`);
  const websocketProtocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const relayPath = `${basePath}/relay`.replace(/\/{2,}/gu, '/');

  return {
    MARKLAB_PUBLIC_WEB_URL: baseUrl,
    MARKLAB_PUBLIC_API_URL: baseUrl,
    MARKLAB_PUBLIC_RELAY_WS_URL: `${websocketProtocol}//${url.host}${relayPath}`,
  };
}

function mergedEnv(extraEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete env[key];
  }
  return env;
}

export const defaultCommandExecutor: CommandExecutor = (command, args, options) => {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let timeout: NodeJS.Timeout | undefined;

    const settle = (result: CommandExecution): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve(result);
    };

    const child = spawn(command, args, {
      env: mergedEnv(options.env),
      shell: false,
      windowsHide: true,
    });

    timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, options.timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      settle({ exitCode: null, signal: null, stdout, stderr, error, timedOut });
    });
    child.on('close', (exitCode, signal) => {
      settle({ exitCode, signal, stdout, stderr, timedOut });
    });
  });
};

function parseJsonOutput<T>(stdout: string, stderr: string, exitCode: number | null): T | JsonErrorResponse {
  try {
    return JSON.parse(stdout) as T | JsonErrorResponse;
  } catch {
    throw new MarkLabCliError('invalid_json', 'MarkLab CLI returned invalid JSON.', {
      details: { stdout, stderr },
      exitCode,
      stderr,
    });
  }
}

function commandUnavailableMessage(command: string): string {
  return `MarkLab CLI is not available at "${command}". Check the plugin setting or install @marklab/cli.`;
}

export class MarkLabCliAdapter {
  private readonly commandLine: string;
  private readonly relayUrlOverride: string;
  private readonly timeoutMs: number;
  private readonly executor: CommandExecutor;

  constructor(options: MarkLabCliAdapterOptions) {
    this.commandLine = options.command || 'marklab';
    this.relayUrlOverride = options.relayUrlOverride ?? '';
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.executor = options.executor ?? defaultCommandExecutor;
  }

  async checkSetup(): Promise<{ available: boolean; command: string; message: string }> {
    const invocation = commandParts(this.commandLine);
    const [command, ...prefixArgs] = invocation;
    const result = await this.executor(command ?? 'marklab', [...prefixArgs, '--help'], {
      env: {},
      timeoutMs: Math.min(this.timeoutMs, 5000),
    });

    if (result.timedOut) {
      return { available: false, command: this.commandLine, message: 'MarkLab CLI did not respond before the setup check timed out.' };
    }
    if (result.error?.code === 'ENOENT') {
      return { available: false, command: this.commandLine, message: commandUnavailableMessage(this.commandLine) };
    }
    if (result.exitCode !== 0) {
      return {
        available: false,
        command: this.commandLine,
        message: result.stderr.trim() || result.stdout.trim() || `MarkLab CLI exited with code ${result.exitCode ?? 'unknown'}.`,
      };
    }
    return { available: true, command: this.commandLine, message: 'MarkLab CLI is available.' };
  }

  status(filePath: string): Promise<MarkLabStatusResponse> {
    return this.runJson<MarkLabStatusResponse>(['status', filePath, '--json']);
  }

  shareState(filePath: string): Promise<MarkLabShareStateResponse> {
    return this.runJson<MarkLabShareStateResponse>(['share-state', filePath, '--json']);
  }

  createLink(filePath: string, role: MarkLabLinkRole): Promise<MarkLabCreatedLinkResponse> {
    return this.runJson<MarkLabCreatedLinkResponse>(['create-link', filePath, '--role', role, '--json']);
  }

  async openBackground(filePath: string, options: { openBrowser?: boolean } = {}): Promise<void> {
    const args = ['open', filePath, '--background'];
    if (options.openBrowser === false) args.push('--no-browser');
    await this.runText(args);
  }

  async stop(filePath: string): Promise<void> {
    await this.runText(['stop', filePath]);
  }

  private async execute(args: string[]): Promise<CommandExecution> {
    const invocation = commandParts(this.commandLine);
    const [command, ...prefixArgs] = invocation;
    return this.executor(command ?? 'marklab', [...prefixArgs, ...args], {
      env: relayEnvFromOverride(this.relayUrlOverride),
      timeoutMs: this.timeoutMs,
    });
  }

  private async runText(args: string[]): Promise<string> {
    const result = await this.execute(args);
    this.throwIfCommandFailed(result);
    return result.stdout;
  }

  private async runJson<T extends { ok: true }>(args: string[]): Promise<T> {
    const result = await this.execute(args);

    if (result.timedOut) {
      throw new MarkLabCliError('timeout', 'MarkLab CLI command timed out.', { stderr: result.stderr, exitCode: result.exitCode });
    }
    if (result.error?.code === 'ENOENT') {
      throw new MarkLabCliError('cli_unavailable', commandUnavailableMessage(this.commandLine), { stderr: result.stderr, exitCode: result.exitCode });
    }

    if (result.exitCode !== 0) {
      if (result.stdout.trim()) {
        const parsed = parseJsonOutput<T>(result.stdout, result.stderr, result.exitCode);
        if ('ok' in parsed && parsed.ok === false) {
          throw new MarkLabCliError(parsed.code ?? 'command_failed', parsed.message ?? 'MarkLab CLI command failed.', {
            details: parsed.details,
            stderr: result.stderr,
            exitCode: result.exitCode,
          });
        }
      }
      throw new MarkLabCliError('command_failed', result.stderr.trim() || 'MarkLab CLI command failed.', {
        stderr: result.stderr,
        exitCode: result.exitCode,
      });
    }

    const parsed = parseJsonOutput<T>(result.stdout, result.stderr, result.exitCode);
    if (!('ok' in parsed) || parsed.ok !== true) {
      throw new MarkLabCliError('invalid_json', 'MarkLab CLI JSON did not include ok: true.', {
        details: parsed,
        stderr: result.stderr,
        exitCode: result.exitCode,
      });
    }
    return parsed;
  }

  private throwIfCommandFailed(result: CommandExecution): void {
    if (result.timedOut) {
      throw new MarkLabCliError('timeout', 'MarkLab CLI command timed out.', { stderr: result.stderr, exitCode: result.exitCode });
    }
    if (result.error?.code === 'ENOENT') {
      throw new MarkLabCliError('cli_unavailable', commandUnavailableMessage(this.commandLine), { stderr: result.stderr, exitCode: result.exitCode });
    }
    if (result.exitCode !== 0) {
      throw new MarkLabCliError('command_failed', result.stderr.trim() || 'MarkLab CLI command failed.', {
        stderr: result.stderr,
        exitCode: result.exitCode,
      });
    }
  }
}

export function humanizeCliError(error: unknown): string {
  if (!(error instanceof MarkLabCliError)) {
    return error instanceof Error ? error.message : String(error);
  }

  switch (error.code) {
    case 'cli_unavailable':
      return error.message;
    case 'daemon_not_running':
    case 'file_not_watched':
      return 'This note is not currently hosted by MarkLab.';
    case 'relay_unavailable':
      return 'MarkLab could not reach the relay. Check your network or relay settings.';
    case 'host_offline':
      return 'The host is offline. Open MarkLab again on the host machine.';
    case 'sync_paused':
    case 'conflict_required':
      return 'MarkLab sync is paused for this note. Inspect the conflict before continuing.';
    case 'invalid_target':
      return error.message;
    case 'timeout':
      return 'MarkLab CLI did not respond before the command timed out.';
    default:
      return error.message;
  }
}
