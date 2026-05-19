import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import http from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildLocalUrls,
  buildNativeJoinDeepLink,
  chooseLocalPorts,
  choosePort,
  legacyCliEnabled,
  parseCliArgs,
  parseHostedCollabLink,
  pickJoinDirectory,
  safeRelayJoinFilename,
} from './marklab.mjs';
import { createDaemonEntry, writeDaemonRegistry } from './daemon-supervisor.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function markdownHash(markdown) {
  return `sha256:${createHash('sha256').update(markdown).digest('hex')}`;
}

function listenOnLoopback(port) {
  const server = net.createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

async function freePort() {
  const server = await listenOnLoopback(0);
  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise((resolveClose) => server.close(resolveClose));
    throw new Error('missing_test_port');
  }
  const port = address.port;
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

async function startRelayAccessServer(access) {
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/api/relay/rooms/room_1/access')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        relayRoomId: 'room_1',
        grantId: 'grant_1',
        role: access.canWrite ? 'edit' : 'view',
        canRead: true,
        canWrite: access.canWrite,
        hostOnline: access.hostOnline,
        hostSessionId: access.hostOnline ? 'host_1' : null,
        sharedRevision: 1,
        lastSharedHash: 'sha256:shared',
        yjsStateBase64: null,
        markdown: access.markdown ?? '# Shared\n',
        stale: !access.hostOnline,
        suggestedFilename: access.suggestedFilename ?? 'README.md',
      }));
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  const port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') reject(new Error('missing_test_port'));
      else resolve(address.port);
    });
  });
  return {
    apiUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  };
}

async function startNativeOwnedDaemonServer(expectedToken) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
    if (req.url === '/api/local/access-grants' && req.method === 'POST') {
      if (req.headers.authorization !== `Bearer ${expectedToken}`) {
        res.statusCode = 403;
        res.end(JSON.stringify({ error: 'forbidden' }));
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.statusCode = 201;
      res.end(JSON.stringify({
        role: 'edit',
        grantId: 'grant_native',
        relayRoomId: 'room_native',
        url: 'http://127.0.0.1:5175/relay/room_native?token=native&mode=edit',
        expiresAt: null,
        createdAt: '2026-05-15T12:00:00.000Z',
      }));
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  const port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') reject(new Error('missing_test_port'));
      else resolve(address.port);
    });
  });
  return {
    apiUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  };
}

function runCli(args, env, timeoutMs = 90000) {
  const child = spawn(process.execPath, ['apps/cli/marklab.mjs', ...args], {
    cwd: repoRoot,
    env: { ...process.env, MARKLAB_ENABLE_LEGACY_CLI: '1', ...env },
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

  return new Promise((resolveRun, rejectRun) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      rejectRun(new Error(`marklab ${args.join(' ')} timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, timeoutMs);

    child.once('error', (error) => {
      clearTimeout(timer);
      rejectRun(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolveRun({ code, signal, stdout, stderr });
    });
  });
}

async function waitForNativeShareRequest(appSupportDirectory, timeoutMs = 5000) {
  const requestsDirectory = join(appSupportDirectory, 'cli-requests');
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt <= timeoutMs) {
    try {
      const files = (await readdir(requestsDirectory)).filter((file) => file.endsWith('.json'));
      if (files.length > 0) {
        const file = join(requestsDirectory, files[0]);
        return JSON.parse(await readFile(file, 'utf8'));
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw lastError ?? new Error('Timed out waiting for native share request.');
}

async function runCliWithNativeShareResponse(args, env, responseForRequest) {
  const child = spawn(process.execPath, ['apps/cli/marklab.mjs', ...args], {
    cwd: repoRoot,
    env: { ...process.env, MARKLAB_ENABLE_LEGACY_CLI: '0', ...env },
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

  const request = await waitForNativeShareRequest(env.MARKLAB_APP_SUPPORT_DIR);
  const responseDirectory = join(env.MARKLAB_APP_SUPPORT_DIR, 'cli-responses');
  await mkdir(responseDirectory, { recursive: true });
  await writeFile(
    join(responseDirectory, `${request.requestId}.json`),
    JSON.stringify(responseForRequest(request)),
    'utf8',
  );

  return new Promise((resolveRun, rejectRun) => {
    child.once('error', rejectRun);
    child.once('exit', (code, signal) => resolveRun({ code, signal, stdout, stderr, request }));
  });
}

function runCliUntilOutput(args, env, pattern, timeoutMs = 90000) {
  const child = spawn(process.execPath, ['apps/cli/marklab.mjs', ...args], {
    cwd: repoRoot,
    env: { ...process.env, MARKLAB_ENABLE_LEGACY_CLI: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let matched = false;

  return new Promise((resolveRun, rejectRun) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      rejectRun(new Error(`marklab ${args.join(' ')} timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, timeoutMs);

    function maybeResolve() {
      if (matched) return;
      if (!pattern.test(stdout)) return;
      matched = true;
      child.kill('SIGTERM');
    }

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
      maybeResolve();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      rejectRun(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (!matched) {
        rejectRun(new Error(`marklab ${args.join(' ')} exited before expected output\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        return;
      }
      resolveRun({ code, signal, stdout, stderr });
    });
  });
}

function expectCliOk(result) {
  expect(result, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toMatchObject({
    code: 0,
    signal: null,
  });
}

describe('marklab CLI', () => {
  it('keeps legacy local-daemon commands disabled unless explicitly opted in', async () => {
    expect(legacyCliEnabled({})).toBe(false);
    expect(legacyCliEnabled({ MARKLAB_ENABLE_LEGACY_CLI: '1' })).toBe(true);

    const result = await runCli(['recent', '--json'], { MARKLAB_ENABLE_LEGACY_CLI: '0' }, 30000);
    expect(result.code).toBe(8);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      code: 'legacy_cli_disabled',
    });
  });

  it('opens hosted collab edit links in MarkLab.app without enabling the legacy daemon CLI', async () => {
    const editLink = 'https://app.example.test/collab?docId=doc_1&branchId=branch_1&token=ml_access_edit&mode=edit';

    expect(parseHostedCollabLink(editLink)).toMatchObject({
      docId: 'doc_1',
      branchId: 'branch_1',
      token: 'ml_access_edit',
      mode: 'edit',
    });
    expect(buildNativeJoinDeepLink(editLink)).toBe(
      'marklab://join?url=https%3A%2F%2Fapp.example.test%2Fcollab%3FdocId%3Ddoc_1%26branchId%3Dbranch_1%26token%3Dml_access_edit%26mode%3Dedit',
    );
    expect(buildNativeJoinDeepLink(editLink, { MARKLAB_APP_URL_SCHEME: 'marklab-beta' })).toBe(
      'marklab-beta://join?url=https%3A%2F%2Fapp.example.test%2Fcollab%3FdocId%3Ddoc_1%26branchId%3Dbranch_1%26token%3Dml_access_edit%26mode%3Dedit',
    );

    const result = await runCli(['join', editLink, '--json'], {
      MARKLAB_ENABLE_LEGACY_CLI: '0',
      MARKLAB_NO_OPEN: 'true',
    }, 30000);
    expectCliOk(result);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      link: editLink,
      nativeJoinUrl: buildNativeJoinDeepLink(editLink),
      opened: false,
    });
  });

  it('keeps hosted view links browser-only instead of routing them into local app join', async () => {
    const viewLink = 'https://app.example.test/collab?docId=doc_1&branchId=branch_1&token=ml_access_view&mode=view';
    const result = await runCli(['join', viewLink, '--json'], {
      MARKLAB_ENABLE_LEGACY_CLI: '0',
      MARKLAB_NO_OPEN: 'true',
    }, 30000);

    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      code: 'invalid_target',
      message: 'View links stay browser-only. Ask for an edit link to join in MarkLab.app.',
    });
  });

  it('rejects hosted collab edit links without raw access tokens before opening the native app', async () => {
    const tokenlessEditLink = 'https://app.example.test/collab?docId=doc_1&branchId=branch_1&mode=edit';

    expect(() => parseHostedCollabLink(tokenlessEditLink)).toThrow('join link is missing token');
    const result = await runCli(['join', tokenlessEditLink, '--json'], {
      MARKLAB_ENABLE_LEGACY_CLI: '0',
      MARKLAB_NO_OPEN: 'true',
    }, 30000);

    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      code: 'invalid_target',
      message: 'join link is missing token.',
    });
  });

  it('opens local files through the native app path without enabling the legacy daemon CLI', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'marklab-cli-native-open-'));
    const markdownPath = join(directory, 'native.md');
    await writeFile(markdownPath, '# Native open\n', 'utf8');
    const canonicalMarkdownPath = await realpath(markdownPath);

    const result = await runCli(['open', markdownPath, '--json'], {
      MARKLAB_ENABLE_LEGACY_CLI: '0',
      MARKLAB_NO_OPEN: 'true',
    }, 30000);

    expectCliOk(result);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      path: canonicalMarkdownPath,
      action: 'open_native_file',
      opened: false,
    });
  });

  it('reports native launch failures instead of returning opened true', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'marklab-cli-native-open-fail-'));
    const markdownPath = join(directory, 'native.md');
    await writeFile(markdownPath, '# Native open\n', 'utf8');

    const result = await runCli(['open', markdownPath, '--json'], {
      MARKLAB_ENABLE_LEGACY_CLI: '0',
      MARKLAB_OPEN_COMMAND_FOR_TEST: '/usr/bin/false',
    }, 30000);

    expect(result.code).toBe(8);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      code: 'native_launch_failed',
    });
  });

  it('routes share through MarkLab.app in native mode instead of minting a daemon relay link', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'marklab-cli-native-share-'));
    const markdownPath = join(directory, 'share.md');
    await writeFile(markdownPath, '# Native share\n', 'utf8');

    const result = await runCli(['share', markdownPath, '--json'], {
      MARKLAB_ENABLE_LEGACY_CLI: '0',
      MARKLAB_NO_OPEN: 'true',
    }, 30000);

    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      code: 'invalid_target',
      message: 'share requires --edit or --view.',
    });
  });

  it('creates edit and view links through the native app request bridge without legacy CLI opt-in', async () => {
    for (const role of ['edit', 'view']) {
      const directory = await mkdtemp(join(tmpdir(), `marklab-cli-native-share-${role}-`));
      const appSupportDirectory = join(directory, 'app-support');
      const markdownPath = join(directory, 'share.md');
      await writeFile(markdownPath, '# Native share\n', 'utf8');
      const canonicalMarkdownPath = await realpath(markdownPath);

      const result = await runCliWithNativeShareResponse(
        ['share', markdownPath, `--${role}`, '--json'],
        {
          MARKLAB_APP_SUPPORT_DIR: appSupportDirectory,
          MARKLAB_NO_OPEN: 'true',
          MARKLAB_NATIVE_CLI_TIMEOUT_MS: '5000',
        },
        (request) => ({
          ok: true,
          requestId: request.requestId,
          action: 'native_share_link_created',
          file: request.file,
          role: request.role,
          url: `https://app.example.test/collab?docId=doc_cli&branchId=branch_main&token=ml_access_${role}&mode=${role}`,
          copied: true,
          docId: 'doc_cli',
          branchId: 'branch_main',
          grantId: `grant_${role}`,
          opened: false,
        }),
      );

      expectCliOk(result);
      expect(result.request).toMatchObject({
        schemaVersion: 1,
        action: 'share',
        file: canonicalMarkdownPath,
        role,
      });
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        action: 'native_share_link_created',
        file: canonicalMarkdownPath,
        role,
        url: `https://app.example.test/collab?docId=doc_cli&branchId=branch_main&token=ml_access_${role}&mode=${role}`,
        copied: true,
        docId: 'doc_cli',
        branchId: 'branch_main',
        grantId: `grant_${role}`,
      });
    }
  });

  it('reports a typed timeout when the native app does not answer a share request', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'marklab-cli-native-share-timeout-'));
    const appSupportDirectory = join(directory, 'app-support');
    const markdownPath = join(directory, 'share.md');
    await writeFile(markdownPath, '# Native share timeout\n', 'utf8');

    const result = await runCli(['share', markdownPath, '--edit', '--json'], {
      MARKLAB_ENABLE_LEGACY_CLI: '0',
      MARKLAB_APP_SUPPORT_DIR: appSupportDirectory,
      MARKLAB_NO_OPEN: 'true',
      MARKLAB_NATIVE_CLI_TIMEOUT_MS: '25',
    }, 30000);

    expect(result.code).toBe(8);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      code: 'native_share_timeout',
    });
    await expect(readdir(join(appSupportDirectory, 'cli-requests'))).resolves.toEqual([]);
  });

  it('points forbidden agent writes at the current native coordination commands', async () => {
    const result = await runCli(['write', 'README.md', '--json'], {
      MARKLAB_ENABLE_LEGACY_CLI: '0',
      MARKLAB_NO_OPEN: 'true',
    }, 30000);

    expect(result.code).toBe(2);
    const body = JSON.parse(result.stdout);
    expect(body).toMatchObject({
      ok: false,
      code: 'forbidden_agent_write',
    });
    expect(body.message).toContain('marklab wait');
    expect(body.message).toContain('marklab status');
    expect(body.message).toContain('marklab conflict');
    expect(body.message).not.toContain('save-version');
  });

  it('reads native shared-file status, wait, and conflict state from MarkLab.app support files without legacy opt-in', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'marklab-cli-native-state-'));
    const appSupportDirectory = join(directory, 'app-support');
    await mkdir(appSupportDirectory, { recursive: true });
    const markdownPath = join(directory, 'shared.md');
    const markdown = '# Synced native file\n';
    await writeFile(markdownPath, markdown, 'utf8');
    const canonicalMarkdownPath = await realpath(markdownPath);
    const hash = markdownHash(markdown);
    const now = '2026-05-18T12:00:00Z';

    await writeFile(join(appSupportDirectory, 'shared-document-bindings.json'), JSON.stringify({
      schemaVersion: 1,
      bindings: {
        [canonicalMarkdownPath]: {
          schemaVersion: 1,
          filePath: canonicalMarkdownPath,
          docId: 'doc_native',
          branchId: 'branch_native',
          mode: 'edit',
          token: null,
          appEditorURL: 'https://app.example.test/collab?docId=doc_native&branchId=branch_native&mode=edit&clientKind=app&nativeShell=markedit',
          localDocId: 'local_native',
          baselineHash: hash,
          createdAt: now,
          updatedAt: now,
        },
      },
    }), 'utf8');
    await writeFile(join(appSupportDirectory, 'projection-baselines.json'), JSON.stringify({
      schemaVersion: 1,
      baselines: {
        [canonicalMarkdownPath]: {
          schemaVersion: 1,
          lastProjectedMarkdown: markdown,
          lastProjectedHash: hash,
          lastProviderStateFingerprint: `provider-ytext:${hash}`,
          updatedAt: now,
        },
      },
    }), 'utf8');

    const env = {
      MARKLAB_ENABLE_LEGACY_CLI: '0',
      MARKLAB_APP_SUPPORT_DIR: appSupportDirectory,
    };

    const status = await runCli(['status', markdownPath, '--json'], env, 30000);
    expectCliOk(status);
    expect(JSON.parse(status.stdout)).toMatchObject({
      ok: true,
      path: canonicalMarkdownPath,
      shared: true,
      syncState: 'synced',
      docId: 'doc_native',
      branchId: 'branch_native',
      conflict: null,
    });

    const waited = await runCli(['wait', markdownPath, '--synced', '--json', '--timeout', '1000'], env, 30000);
    expectCliOk(waited);
    expect(JSON.parse(waited.stdout)).toMatchObject({
      ok: true,
      path: canonicalMarkdownPath,
      syncState: 'synced',
      observedHash: hash,
    });

    const conflict = await runCli(['conflict', markdownPath, '--json'], env, 30000);
    expectCliOk(conflict);
    expect(JSON.parse(conflict.stdout)).toMatchObject({
      ok: true,
      path: canonicalMarkdownPath,
      hasConflict: false,
      conflict: null,
    });
  });

  it('parses foreground, background, status, and stop commands', () => {
    expect(parseCliArgs(['open', 'README.md'])).toEqual({
      command: 'open',
      file: 'README.md',
      json: false,
      background: false,
    });
    expect(parseCliArgs(['open', 'README.md', '--background'])).toEqual({
      command: 'open',
      file: 'README.md',
      json: false,
      background: true,
    });
    expect(parseCliArgs(['status'])).toEqual({ command: 'status', file: null, json: false });
    expect(parseCliArgs(['stop', 'README.md'])).toEqual({
      command: 'stop',
      file: 'README.md',
      all: false,
    });
    expect(parseCliArgs(['stop', '--all'])).toEqual({
      command: 'stop',
      file: null,
      all: true,
    });
    expect(parseCliArgs(['share', 'README.md'])).toEqual({
      command: 'share',
      file: 'README.md',
      json: false,
      daemonOnly: false,
      shareRole: null,
    });
    expect(parseCliArgs(['share', 'README.md', '--json', '--daemon-only', '--edit'])).toEqual({
      command: 'share',
      file: 'README.md',
      json: true,
      daemonOnly: true,
      shareRole: 'edit',
    });
    expect(parseCliArgs(['share', 'README.md', '--view'])).toEqual({
      command: 'share',
      file: 'README.md',
      json: false,
      daemonOnly: false,
      shareRole: 'view',
    });
    expect(parseCliArgs(['join', 'https://example.test/relay/room_1?token=secret', '--dir', './docs', '--name', 'shared.md', '--create-dir'])).toEqual({
      command: 'join',
      link: 'https://example.test/relay/room_1?token=secret',
      file: null,
      dir: './docs',
      name: 'shared.md',
      createDir: true,
      replace: false,
      review: false,
      cancel: false,
      background: false,
      pickDir: false,
      json: false,
    });
    expect(parseCliArgs(['join', 'https://example.test/relay/room_1?token=secret', '--dir', './docs', '--name', 'shared.md', '--create-dir', '--background'])).toEqual({
      command: 'join',
      link: 'https://example.test/relay/room_1?token=secret',
      file: null,
      dir: './docs',
      name: 'shared.md',
      createDir: true,
      replace: false,
      review: false,
      cancel: false,
      background: true,
      pickDir: false,
      json: false,
    });
    expect(parseCliArgs(['join', 'https://example.test/relay/room_1?token=secret', '--pick-dir', '--background'])).toEqual({
      command: 'join',
      link: 'https://example.test/relay/room_1?token=secret',
      file: null,
      dir: null,
      name: null,
      createDir: false,
      replace: false,
      review: false,
      cancel: false,
      background: true,
      pickDir: true,
      json: false,
    });
    expect(parseCliArgs(['share-state', 'README.md', '--json'])).toEqual({
      command: 'share-state',
      file: 'README.md',
      json: true,
    });
    expect(parseCliArgs(['create-link', 'README.md', '--role', 'view'])).toEqual({
      command: 'create-link',
      file: 'README.md',
      role: 'view',
      json: false,
    });
    expect(parseCliArgs(['revoke-link', 'README.md', 'grant_1'])).toEqual({
      command: 'revoke-link',
      file: 'README.md',
      grantId: 'grant_1',
      json: false,
    });
  });

  it('normalizes local mirror filenames and rejects path traversal names', () => {
    expect(safeRelayJoinFilename('shared-notes')).toBe('shared-notes.md');
    expect(safeRelayJoinFilename('README.md')).toBe('README.md');
    expect(() => safeRelayJoinFilename('../README.md')).toThrow('--name must be a Markdown filename');
    expect(() => safeRelayJoinFilename('nested/README.md')).toThrow('--name must be a Markdown filename');
  });

  it('supports test-controlled folder picking without opening a native picker', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'marklab-cli-pick-dir-'));
    await expect(pickJoinDirectory({ MARKLAB_PICK_DIR_FOR_TEST: directory }, 'darwin')).resolves.toBe(resolve(directory));
  });

  it('rejects host-offline join before creating directories or files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'marklab-cli-join-offline-'));
    const targetDirectory = join(directory, 'docs');
    const existingTarget = join(directory, 'existing.md');
    await writeFile(existingTarget, '# Existing offline\n', 'utf8');
    const relay = await startRelayAccessServer({ canWrite: true, hostOnline: false });
    const link = `http://127.0.0.1:5175/relay/room_1?token=secret&apiUrl=${encodeURIComponent(relay.apiUrl)}`;

    try {
      const result = await runCli(['join', link, '--dir', targetDirectory, '--name', 'README.md', '--create-dir'], {
        MARKLAB_NO_OPEN: 'true',
      }, 30000);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Host offline. Ask the host to open MarkLab again.');
      expect(existsSync(targetDirectory)).toBe(false);

      const existingResult = await runCli(['join', link, existingTarget], { MARKLAB_NO_OPEN: 'true' }, 30000);
      expect(existingResult.code).toBe(1);
      expect(existingResult.stderr).toContain('Host offline. Ask the host to open MarkLab again.');
      await expect(readFile(existingTarget, 'utf8')).resolves.toBe('# Existing offline\n');
    } finally {
      await relay.close();
    }
  });

  it('rejects view links and non-empty target review/cancel before mutating bytes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'marklab-cli-join-safety-'));
    const target = join(directory, 'README.md');
    await writeFile(target, '# Existing\n', 'utf8');

    const viewRelay = await startRelayAccessServer({ canWrite: false, hostOnline: true });
    const viewLink = `http://127.0.0.1:5175/relay/room_1?token=view&apiUrl=${encodeURIComponent(viewRelay.apiUrl)}`;
    try {
      const result = await runCli(['join', viewLink, target], { MARKLAB_NO_OPEN: 'true' }, 30000);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('View links cannot start a local mirror.');
      await expect(readFile(target, 'utf8')).resolves.toBe('# Existing\n');
    } finally {
      await viewRelay.close();
    }

    const editRelay = await startRelayAccessServer({ canWrite: true, hostOnline: true, markdown: '# Shared\n' });
    const editLink = `http://127.0.0.1:5175/relay/room_1?token=edit&apiUrl=${encodeURIComponent(editRelay.apiUrl)}`;
    try {
      const cancelled = await runCli(['join', editLink, target, '--cancel'], { MARKLAB_NO_OPEN: 'true' }, 30000);
      expectCliOk(cancelled);
      expect(cancelled.stdout).toContain('Join cancelled. No file was changed.');
      await expect(readFile(target, 'utf8')).resolves.toBe('# Existing\n');

      const review = await runCli(['join', editLink, target, '--review'], { MARKLAB_NO_OPEN: 'true' }, 30000);
      expect(review.code).toBe(1);
      expect(review.stderr).toContain('Review conflict is deferred to Plan 3.');
      await expect(readFile(target, 'utf8')).resolves.toBe('# Existing\n');

      const blockingServer = await listenOnLoopback(0);
      const blockingAddress = blockingServer.address();
      if (!blockingAddress || typeof blockingAddress === 'string') throw new Error('missing_test_port');
      try {
        const replaced = await runCli(
          ['join', editLink, target, '--replace'],
          {
            MARKLAB_NO_OPEN: 'true',
            MARKLAB_API_PORT: String(blockingAddress.port),
            MARKLAB_WEB_PORT: String(await freePort()),
          },
          30000,
        );
        expect(replaced.code).toBe(1);
        expect(replaced.stderr).toContain(`MARKLAB_API_PORT=${blockingAddress.port} is already in use`);
        await expect(readFile(target, 'utf8')).resolves.toBe('# Shared\n');
      } finally {
        await new Promise((resolveClose) => blockingServer.close(resolveClose));
      }
    } finally {
      await editRelay.close();
    }
  });

  it('puts the local daemon token in the local browser URL fragment', () => {
    expect(buildLocalUrls(3011, 5175, 'secret token')).toMatchObject({
      apiUrl: 'http://127.0.0.1:3011',
      webUrl: 'http://127.0.0.1:5175',
      localUrl: 'http://127.0.0.1:5175/local#token=secret%20token',
    });
  });

  it('reports a configured port conflict instead of silently reusing it', async () => {
    const server = await listenOnLoopback(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing_test_port');
    try {
      await expect(choosePort(3011, 'MARKLAB_API_PORT', { MARKLAB_API_PORT: String(address.port) })).rejects.toThrow(
        `MARKLAB_API_PORT=${address.port} is already in use`,
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('rejects identical configured API and web ports', async () => {
    await expect(
      chooseLocalPorts({
        MARKLAB_API_PORT: '49151',
        MARKLAB_WEB_PORT: '49151',
      }),
    ).rejects.toThrow('MARKLAB_API_PORT and MARKLAB_WEB_PORT must be different');
  });

  it('starts foreground share and prints a one-time edit relay URL', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'marklab-cli-share-'));
    const markdownPath = join(directory, 'README.md');
    await writeFile(markdownPath, '# Share\n\nInitial body.\n', 'utf8');
    const canonicalMarkdownPath = await realpath(markdownPath);

    const result = await runCliUntilOutput(
      ['share', markdownPath],
      {
        MARKLAB_APP_SUPPORT_DIR: join(directory, 'app-support'),
        MARKLAB_RELAY_MODE: 'development',
        MARKLAB_NO_OPEN: 'true',
        MARKLAB_API_PORT: String(await freePort()),
        MARKLAB_WEB_PORT: String(await freePort()),
      },
      /Edit link: http:\/\/127\.0\.0\.1:\d+\/relay\//u,
      120000,
    );

    expect(result.stdout).toContain(`Sharing ${canonicalMarkdownPath}`);
    expect(result.stdout).toContain('mode=edit');
  }, 130000);

  it('reuses a native-app-owned daemon for share --json instead of starting a second watcher', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'marklab-cli-native-owned-'));
    const appSupportDirectory = join(directory, 'app-support');
    const registryPath = join(appSupportDirectory, 'local-daemons.json');
    const markdownPath = join(directory, 'README.md');
    await writeFile(markdownPath, '# Native owner\n', 'utf8');
    const canonicalMarkdownPath = await realpath(markdownPath);
    const token = 'native-token';
    const daemon = await startNativeOwnedDaemonServer(token);

    try {
      await writeDaemonRegistry({
        schemaVersion: 1,
        daemons: [createDaemonEntry({
          realpath: canonicalMarkdownPath,
          pid: process.pid,
          apiPort: Number(new URL(daemon.apiUrl).port),
          webPort: 5175,
          apiUrl: daemon.apiUrl,
          webUrl: 'http://127.0.0.1:5175',
          localUrl: 'marklab://open/README.md',
          token,
          ownerKind: 'app',
        })],
      }, registryPath);

      const result = await runCli(['share', markdownPath, '--json'], {
        MARKLAB_APP_SUPPORT_DIR: appSupportDirectory,
        MARKLAB_LOCAL_DAEMON_REGISTRY_PATH: registryPath,
        MARKLAB_NO_OPEN: 'true',
      }, 30000);
      expectCliOk(result);
      const body = JSON.parse(result.stdout);
      expect(body).toMatchObject({
        ok: true,
        path: canonicalMarkdownPath,
        reusedDaemon: true,
        grantId: 'grant_native',
        relayRoomId: 'room_native',
        url: 'http://127.0.0.1:5175/relay/room_native?token=native&mode=edit',
      });
      expect(daemon.requests).toEqual([
        { method: 'POST', url: '/api/local/access-grants', authorization: 'Bearer native-token' },
      ]);
    } finally {
      await daemon.close();
    }
  });

  it('starts or reuses a daemon without creating a hidden relay link for native app bootstrap', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'marklab-cli-daemon-only-'));
    const appSupportDirectory = join(directory, 'app-support');
    const registryPath = join(appSupportDirectory, 'local-daemons.json');
    const markdownPath = join(directory, 'README.md');
    await writeFile(markdownPath, '# Native owner\n', 'utf8');
    const canonicalMarkdownPath = await realpath(markdownPath);
    const token = 'native-token';
    const daemon = await startNativeOwnedDaemonServer(token);

    try {
      await writeDaemonRegistry({
        schemaVersion: 1,
        daemons: [createDaemonEntry({
          realpath: canonicalMarkdownPath,
          pid: process.pid,
          apiPort: Number(new URL(daemon.apiUrl).port),
          webPort: 5175,
          apiUrl: daemon.apiUrl,
          webUrl: 'http://127.0.0.1:5175',
          localUrl: 'marklab://open/README.md',
          token,
          ownerKind: 'app',
        })],
      }, registryPath);

      const result = await runCli(['share', markdownPath, '--json', '--daemon-only'], {
        MARKLAB_APP_SUPPORT_DIR: appSupportDirectory,
        MARKLAB_LOCAL_DAEMON_REGISTRY_PATH: registryPath,
        MARKLAB_NO_OPEN: 'true',
      }, 30000);
      expectCliOk(result);
      const body = JSON.parse(result.stdout);
      expect(body).toMatchObject({
        ok: true,
        path: canonicalMarkdownPath,
        reusedDaemon: true,
        browserUrl: 'marklab://open/README.md',
        apiUrl: daemon.apiUrl,
      });
      expect(body).not.toHaveProperty('grantId');
      expect(body).not.toHaveProperty('url');
      expect(daemon.requests).toEqual([]);
    } finally {
      await daemon.close();
    }
  });

  it('opens and stops a real background daemon for one local Markdown file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'marklab-cli-bg-'));
    const appSupportDirectory = join(directory, 'app-support');
    const markdownPath = join(directory, 'README.md');
    await writeFile(markdownPath, '# Background daemon\n\nInitial body.\n', 'utf8');
    const canonicalMarkdownPath = await realpath(markdownPath);

    const env = {
      MARKLAB_APP_SUPPORT_DIR: appSupportDirectory,
      MARKLAB_RELAY_MODE: 'development',
      MARKLAB_NO_OPEN: 'true',
      MARKLAB_API_PORT: String(await freePort()),
      MARKLAB_WEB_PORT: String(await freePort()),
      DATABASE_URL: 'postgres://ambient-env-should-not-affect-local-daemon',
    };

    try {
      const opened = await runCli(['open', markdownPath, '--background'], env);
      expectCliOk(opened);
      expect(opened.stdout).toContain(`Opened ${canonicalMarkdownPath}`);
      expect(opened.stdout).toContain('Browser URL: http://127.0.0.1:');

      const browserUrl = opened.stdout.match(/Browser URL: (http:\/\/127\.0\.0\.1:\d+\/local#token=\S+)/)?.[1];
      expect(browserUrl).toBeTruthy();
      const token = decodeURIComponent(new URL(browserUrl).hash.replace(/^#token=/u, ''));

      const status = await runCli(['status'], env);
      expectCliOk(status);
      expect(status.stdout).toContain(canonicalMarkdownPath);
      expect(status.stdout).toContain('Last sync state: running');

      const documentResponse = await fetch(`http://127.0.0.1:${env.MARKLAB_API_PORT}/api/local/document`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(documentResponse.status).toBe(200);
      await expect(documentResponse.json()).resolves.toMatchObject({
        absolutePath: canonicalMarkdownPath,
      });

      const createdLink = await runCli(['create-link', markdownPath, '--role', 'view'], env);
      expectCliOk(createdLink);
      expect(createdLink.stdout).toContain('/relay/');
      expect(createdLink.stdout).toContain('mode=view');
      expect(createdLink.stdout).toContain('filename=README.md');

      const shareState = await runCli(['share-state', markdownPath, '--json'], env);
      expectCliOk(shareState);
      const parsedShareState = JSON.parse(shareState.stdout).shareState;
      expect(parsedShareState).toMatchObject({
        localPath: canonicalMarkdownPath,
        hostOnline: true,
        links: [expect.objectContaining({ role: 'view', canCopyExistingUrl: false })],
      });
      expect(shareState.stdout).not.toContain('ml_relay_');
      expect(shareState.stdout).not.toContain('token_hash');

      const grantId = parsedShareState.links[0].grantId;
      const revoked = await runCli(['revoke-link', markdownPath, grantId], env);
      expectCliOk(revoked);
      expect(revoked.stdout).toContain(`Revoked ${grantId}`);

      const stopped = await runCli(['stop', markdownPath], env);
      expectCliOk(stopped);
      expect(stopped.stdout).toContain(`Stopped ${canonicalMarkdownPath}`);

      const finalStatus = await runCli(['status'], env);
      expectCliOk(finalStatus);
      expect(finalStatus.stdout).toContain('No MarkLab local daemons are running.');
    } finally {
      await runCli(['stop', '--all'], env, 30000).catch(() => undefined);
    }
  }, 120000);

  it('joins an edit link as a real background local mirror daemon', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'marklab-cli-join-bg-'));
    const appSupportDirectory = join(directory, 'app-support');
    const targetDirectory = join(directory, 'docs');
    await mkdir(targetDirectory);
    const relay = await startRelayAccessServer({ canWrite: true, hostOnline: true, markdown: '# Shared mirror\n\nInitial body.\n' });
    const link = `http://127.0.0.1:5175/relay/room_1?token=edit&filename=${encodeURIComponent('Host Notes.md')}&apiUrl=${encodeURIComponent(relay.apiUrl)}`;

    const env = {
      MARKLAB_APP_SUPPORT_DIR: appSupportDirectory,
      MARKLAB_NO_OPEN: 'true',
      MARKLAB_API_PORT: String(await freePort()),
      MARKLAB_WEB_PORT: String(await freePort()),
    };

    try {
      const joined = await runCli(['join', link, '--pick-dir', '--background'], {
        ...env,
        MARKLAB_PICK_DIR_FOR_TEST: targetDirectory,
      }, 120000);
      expectCliOk(joined);
      const canonicalTarget = await realpath(join(targetDirectory, 'Host Notes.md'));
      expect(joined.stdout).toContain('Joined relay room room_1');
      expect(joined.stdout).toContain(`Local mirror file: ${canonicalTarget}`);
      expect(joined.stdout).toContain('Sync is running in the background.');
      expect(joined.stdout).toContain(`Stop with: marklab stop ${canonicalTarget}`);
      await expect(readFile(canonicalTarget, 'utf8')).resolves.toBe('# Shared mirror\n\nInitial body.\n');

      const browserUrl = joined.stdout.match(/Local browser URL: (http:\/\/127\.0\.0\.1:\d+\/local#token=\S+)/)?.[1];
      expect(browserUrl).toBeTruthy();
      const token = decodeURIComponent(new URL(browserUrl).hash.replace(/^#token=/u, ''));

      const status = await runCli(['status'], env);
      expectCliOk(status);
      expect(status.stdout).toContain(canonicalTarget);
      expect(status.stdout).toContain('Last sync state: running');

      const documentResponse = await fetch(`http://127.0.0.1:${env.MARKLAB_API_PORT}/api/local/document`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(documentResponse.status).toBe(200);
      await expect(documentResponse.json()).resolves.toMatchObject({
        absolutePath: canonicalTarget,
      });

      const stopped = await runCli(['stop', canonicalTarget], env);
      expectCliOk(stopped);
      expect(stopped.stdout).toContain(`Stopped ${canonicalTarget}`);
    } finally {
      await runCli(['stop', '--all'], env, 30000).catch(() => undefined);
      await relay.close();
    }
  }, 130000);
});
