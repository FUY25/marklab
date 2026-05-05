import { describe, expect, it, vi } from 'vitest';
import {
  MarkLabCliAdapter,
  MarkLabCliError,
  relayEnvFromOverride,
  splitCommandLine,
  type CommandExecutor,
} from '../src/cli-adapter';

describe('splitCommandLine', () => {
  it('splits command settings without using a shell', () => {
    expect(splitCommandLine('npx -y @marklab/cli')).toEqual(['npx', '-y', '@marklab/cli']);
    expect(splitCommandLine('"/Applications/Mark Lab/marklab" --flag')).toEqual(['/Applications/Mark Lab/marklab', '--flag']);
  });

  it('rejects unmatched quotes', () => {
    expect(() => splitCommandLine('"marklab')).toThrow(MarkLabCliError);
  });
});

describe('relayEnvFromOverride', () => {
  it('maps a relay base URL to MarkLab public relay environment variables', () => {
    expect(relayEnvFromOverride('https://relay.example.com/base')).toEqual({
      MARKLAB_PUBLIC_WEB_URL: 'https://relay.example.com/base',
      MARKLAB_PUBLIC_API_URL: 'https://relay.example.com/base',
      MARKLAB_PUBLIC_RELAY_WS_URL: 'wss://relay.example.com/base/relay',
    });
  });

  it('rejects non-http relay URLs', () => {
    expect(() => relayEnvFromOverride('file:///tmp/relay')).toThrow('http:// or https://');
  });
});

describe('MarkLabCliAdapter', () => {
  it('passes file paths with spaces as one argv entry and parses status JSON', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const executor: CommandExecutor = vi.fn(async (command, args) => {
      calls.push({ command, args });
      return {
        exitCode: 0,
        signal: null,
        stdout: JSON.stringify({
          ok: true,
          files: [{ path: '/tmp/My Note.md', daemon: 'missing', syncState: 'error' }],
        }),
        stderr: '',
      };
    });

    const adapter = new MarkLabCliAdapter({ command: 'marklab', executor });
    const status = await adapter.status('/tmp/My Note.md');

    expect(status.files[0]?.path).toBe('/tmp/My Note.md');
    expect(calls[0]).toEqual({
      command: 'marklab',
      args: ['status', '/tmp/My Note.md', '--json'],
    });
  });

  it('maps structured CLI errors to MarkLabCliError codes', async () => {
    const executor: CommandExecutor = vi.fn(async () => ({
      exitCode: 3,
      signal: null,
      stdout: JSON.stringify({ ok: false, code: 'daemon_not_running', message: 'No daemon.' }),
      stderr: '',
    }));

    const adapter = new MarkLabCliAdapter({ command: 'marklab', executor });
    await expect(adapter.shareState('/tmp/a.md')).rejects.toMatchObject({
      code: 'daemon_not_running',
      message: 'No daemon.',
    });
  });

  it('reports malformed JSON from JSON commands', async () => {
    const executor: CommandExecutor = vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      stdout: 'not-json',
      stderr: '',
    }));

    const adapter = new MarkLabCliAdapter({ command: 'marklab', executor });
    await expect(adapter.status('/tmp/a.md')).rejects.toMatchObject({ code: 'invalid_json' });
  });

  it('reports unavailable CLI during setup', async () => {
    const executor: CommandExecutor = vi.fn(async () => ({
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      error: Object.assign(new Error('not found'), { code: 'ENOENT' }),
    }));

    const adapter = new MarkLabCliAdapter({ command: 'missing-marklab', executor });
    await expect(adapter.checkSetup()).resolves.toMatchObject({
      available: false,
      command: 'missing-marklab',
    });
  });

  it('passes relay overrides through the executor environment', async () => {
    const executor: CommandExecutor = vi.fn(async (_command, _args, options) => {
      expect(options.env).toMatchObject({
        MARKLAB_PUBLIC_WEB_URL: 'https://relay.example.com',
        MARKLAB_PUBLIC_API_URL: 'https://relay.example.com',
        MARKLAB_PUBLIC_RELAY_WS_URL: 'wss://relay.example.com/relay',
      });
      return { exitCode: 0, signal: null, stdout: JSON.stringify({ ok: true, files: [] }), stderr: '' };
    });

    const adapter = new MarkLabCliAdapter({
      command: 'marklab',
      relayUrlOverride: 'https://relay.example.com',
      executor,
    });
    await adapter.status('/tmp/a.md');
  });

  it('can start background hosting without opening a browser tab', async () => {
    const calls: string[][] = [];
    const executor: CommandExecutor = vi.fn(async (_command, args) => {
      calls.push(args);
      return { exitCode: 0, signal: null, stdout: '', stderr: '' };
    });

    const adapter = new MarkLabCliAdapter({ command: 'marklab', executor });
    await adapter.openBackground('/tmp/a.md', { openBrowser: false });

    expect(calls[0]).toEqual(['open', '/tmp/a.md', '--background', '--no-browser']);
  });
});
