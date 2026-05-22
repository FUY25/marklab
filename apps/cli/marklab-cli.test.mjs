import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import http from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildNativeJoinDeepLink,
  parseCliArgs,
  parseHostedCollabLink,
  pickJoinDirectory,
  safeJoinFilename,
} from './marklab.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function markdownHash(markdown) {
  return `sha256:${createHash('sha256').update(markdown).digest('hex')}`;
}

async function startNativeExportServer(markdownByBranch, options = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
    const match = /^\/api\/docs\/([^/]+)\/branches\/([^/]+)\/export\.md$/u.exec(req.url ?? '');
    if (req.method === 'GET' && match?.[1] && match[2]) {
      if (options.authorize && !options.authorize(req)) {
        res.statusCode = 403;
        res.end('forbidden');
        return;
      }
      const markdown = markdownByBranch.get(`${decodeURIComponent(match[1])}:${decodeURIComponent(match[2])}`);
      if (markdown === undefined) {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      res.setHeader('content-type', 'text/markdown; charset=utf-8');
      res.end(markdown);
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  const port = await new Promise((resolvePort, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') reject(new Error('missing_test_port'));
      else resolvePort(address.port);
    });
  });
  return {
    apiUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  };
}

function runCli(args, env = {}, timeoutMs = 90000) {
  const child = spawn(process.execPath, ['apps/cli/marklab.mjs', ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
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

async function waitForNativeRequest(appSupportDirectory, timeoutMs = 5000) {
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
  throw lastError ?? new Error('Timed out waiting for native request.');
}

async function runCliWithNativeResponse(args, env, responseForRequest) {
  const child = spawn(process.execPath, ['apps/cli/marklab.mjs', ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
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

  const request = await waitForNativeRequest(env.MARKLAB_APP_SUPPORT_DIR);
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

function expectCliOk(result) {
  expect(result, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toMatchObject({
    code: 0,
    signal: null,
  });
}

describe('marklab CLI', () => {
  it('rejects removed archived daemon commands', async () => {
    const recent = await runCli(['recent', '--json'], { MARKLAB_NO_OPEN: 'true' }, 30000);
    expect(recent.code).toBe(2);
    expect(JSON.parse(recent.stdout)).toMatchObject({
      ok: false,
      code: 'invalid_target',
    });

    const background = await runCli(['open', 'README.md', '--background', '--json'], { MARKLAB_NO_OPEN: 'true' }, 30000);
    expect(background.code).toBe(2);
    expect(JSON.parse(background.stdout).message).toContain('open --background was removed');

    const daemonOnly = await runCli(['share', 'README.md', '--edit', '--daemon-only', '--json'], { MARKLAB_NO_OPEN: 'true' }, 30000);
    expect(daemonOnly.code).toBe(2);
    expect(JSON.parse(daemonOnly.stdout).message).toContain('share --daemon-only was removed');
  });

  it('opens hosted collab edit links in MarkLab.app', async () => {
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

    const result = await runCli(['join', editLink, '--json'], { MARKLAB_NO_OPEN: 'true' }, 30000);
    expectCliOk(result);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      link: editLink,
      nativeJoinUrl: buildNativeJoinDeepLink(editLink),
      opened: false,
    });
  });

  it('joins hosted collab edit links into a chosen folder through the native app request bridge', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'marklab-cli-native-join-'));
    const appSupportDirectory = join(directory, 'app-support');
    const targetDirectory = join(directory, 'docs');
    await mkdir(targetDirectory);
    const editLink = 'https://app.example.test/collab?docId=doc_1&branchId=branch_1&token=ml_access_edit&mode=edit&filename=Host%20Notes.md';

    const result = await runCliWithNativeResponse(
      ['join', editLink, '--dir', targetDirectory, '--background', '--json'],
      {
        MARKLAB_APP_SUPPORT_DIR: appSupportDirectory,
        MARKLAB_NO_OPEN: 'true',
        MARKLAB_NATIVE_CLI_TIMEOUT_MS: '5000',
      },
      (request) => ({
        ok: true,
        requestId: request.requestId,
        action: 'native_join_started',
        file: request.file,
        role: 'edit',
        url: null,
        copied: false,
        docId: 'doc_1',
        branchId: 'branch_1',
        grantId: null,
        opened: false,
      }),
    );

    const targetFile = join(targetDirectory, 'Host Notes.md');
    expectCliOk(result);
    expect(result.request).toMatchObject({
      schemaVersion: 1,
      action: 'join',
      file: targetFile,
      link: editLink,
      role: 'edit',
    });
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      action: 'native_join_started',
      path: targetFile,
      docId: 'doc_1',
      branchId: 'branch_1',
      opened: false,
    });
    await expect(readdir(join(appSupportDirectory, 'cli-requests'))).resolves.toEqual([]);
    await expect(readdir(join(appSupportDirectory, 'cli-responses'))).resolves.toEqual([]);
  });

  it('rejects hosted app join replace before writing a native request', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'marklab-cli-native-join-replace-'));
    const appSupportDirectory = join(directory, 'app-support');
    const targetFile = join(directory, 'Host Notes.md');
    await writeFile(targetFile, '# Existing local notes\n', 'utf8');
    const editLink = 'https://app.example.test/collab?docId=doc_1&branchId=branch_1&token=ml_access_edit&mode=edit&filename=Host%20Notes.md';

    const result = await runCli(['join', editLink, targetFile, '--replace', '--json'], {
      MARKLAB_APP_SUPPORT_DIR: appSupportDirectory,
      MARKLAB_NO_OPEN: 'true',
      MARKLAB_NATIVE_CLI_TIMEOUT_MS: '100',
    }, 30000);

    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      code: 'invalid_target',
      message: expect.stringContaining('Replace is not available for hosted app joins yet.'),
    });
    await expect(readFile(targetFile, 'utf8')).resolves.toBe('# Existing local notes\n');
    expect(existsSync(join(appSupportDirectory, 'cli-requests'))).toBe(false);
  });

  it('keeps hosted view links browser-only and rejects tokenless edit links', async () => {
    const viewLink = 'https://app.example.test/collab?docId=doc_1&branchId=branch_1&token=ml_access_view&mode=view';
    const viewResult = await runCli(['join', viewLink, '--json'], { MARKLAB_NO_OPEN: 'true' }, 30000);
    expect(viewResult.code).toBe(2);
    expect(JSON.parse(viewResult.stdout)).toMatchObject({
      ok: false,
      code: 'invalid_target',
      message: 'View links stay browser-only. Ask for an edit link to join in MarkLab.app.',
    });

    const tokenlessEditLink = 'https://app.example.test/collab?docId=doc_1&branchId=branch_1&mode=edit';
    expect(() => parseHostedCollabLink(tokenlessEditLink)).toThrow('join link is missing token');
    const tokenlessResult = await runCli(['join', tokenlessEditLink, '--json'], { MARKLAB_NO_OPEN: 'true' }, 30000);
    expect(tokenlessResult.code).toBe(2);
    expect(JSON.parse(tokenlessResult.stdout)).toMatchObject({
      ok: false,
      code: 'invalid_target',
      message: 'join link is missing token.',
    });
  });

  it('opens local files through the native app path', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'marklab-cli-native-open-'));
    const markdownPath = join(directory, 'native.md');
    await writeFile(markdownPath, '# Native open\n', 'utf8');
    const canonicalMarkdownPath = await realpath(markdownPath);

    const result = await runCli(['open', markdownPath, '--json'], {
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
      MARKLAB_OPEN_COMMAND_FOR_TEST: '/usr/bin/false',
    }, 30000);

    expect(result.code).toBe(8);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      code: 'native_launch_failed',
    });
  });

  it('creates edit and view links through the native app request bridge', async () => {
    for (const role of ['edit', 'view']) {
      const directory = await mkdtemp(join(tmpdir(), `marklab-cli-native-share-${role}-`));
      const appSupportDirectory = join(directory, 'app-support');
      const markdownPath = join(directory, 'share.md');
      await writeFile(markdownPath, '# Native share\n', 'utf8');
      const canonicalMarkdownPath = await realpath(markdownPath);

      const result = await runCliWithNativeResponse(
        ['share', markdownPath, `--${role}`, '--json'],
        {
          MARKLAB_APP_SUPPORT_DIR: appSupportDirectory,
          MARKLAB_NO_OPEN: 'true',
          MARKLAB_NATIVE_CLI_TIMEOUT_MS: '5000',
          MARKLAB_CONTROL_PLANE_API_URL: 'https://api.example.test',
          MARKLAB_PUBLIC_WEB_URL: 'https://app.example.test',
          MARKLAB_USER_TOKEN: 'ml_user_session',
          MARKLAB_WORKSPACE_ID: 'workspace_1',
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
        hostedConfig: {
          apiBaseURL: 'https://api.example.test',
          webBaseURL: 'https://app.example.test',
          bearerToken: 'ml_user_session',
          workspaceId: 'workspace_1',
        },
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
      await expect(readdir(join(appSupportDirectory, 'cli-requests'))).resolves.toEqual([]);
      await expect(readdir(join(appSupportDirectory, 'cli-responses'))).resolves.toEqual([]);
    }
  });

  it('reports a typed timeout when the native app does not answer a share request', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'marklab-cli-native-share-timeout-'));
    const appSupportDirectory = join(directory, 'app-support');
    const markdownPath = join(directory, 'share.md');
    await writeFile(markdownPath, '# Native share timeout\n', 'utf8');

    const result = await runCli(['share', markdownPath, '--edit', '--json'], {
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

  it('reads native shared-file status, wait, and conflict state from MarkLab.app support files', async () => {
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
      MARKLAB_APP_SUPPORT_DIR: appSupportDirectory,
      MARKLAB_CONTROL_PLANE_API_URL: '',
      MARKLAB_PUBLIC_API_URL: '',
      MARKLAB_USER_TOKEN: '',
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

  it('does not treat local-only files as a successful shared sync wait', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'marklab-cli-native-local-wait-'));
    const appSupportDirectory = join(directory, 'app-support');
    const markdownPath = join(directory, 'local.md');
    await writeFile(markdownPath, '# Local only\n', 'utf8');
    const canonicalMarkdownPath = await realpath(markdownPath);

    const status = await runCli(['status', markdownPath, '--json'], {
      MARKLAB_APP_SUPPORT_DIR: appSupportDirectory,
    }, 30000);
    expectCliOk(status);
    expect(JSON.parse(status.stdout)).toMatchObject({
      ok: true,
      path: canonicalMarkdownPath,
      shared: false,
      syncState: 'local',
    });

    const wait = await runCli(['wait', markdownPath, '--synced', '--json', '--timeout', '25'], {
      MARKLAB_APP_SUPPORT_DIR: appSupportDirectory,
    }, 30000);
    expect(wait.code).toBe(2);
    expect(JSON.parse(wait.stdout)).toMatchObject({
      ok: false,
      code: 'invalid_target',
      details: {
        path: canonicalMarkdownPath,
        syncState: 'local',
      },
    });
  });

  it('keeps native status and wait provider-aware when hosted export verification is configured', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'marklab-cli-native-provider-state-'));
    const appSupportDirectory = join(directory, 'app-support');
    await mkdir(appSupportDirectory, { recursive: true });
    const markdownPath = join(directory, 'shared.md');
    const localMarkdown = '# Local provider pending\n';
    await writeFile(markdownPath, localMarkdown, 'utf8');
    const canonicalMarkdownPath = await realpath(markdownPath);
    const localHash = markdownHash(localMarkdown);
    const staleRemoteMarkdown = '# Remote still stale\n';
    const exportServer = await startNativeExportServer(new Map([
      ['doc_native:branch_native', staleRemoteMarkdown],
    ]));

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
          baselineHash: localHash,
          createdAt: '2026-05-18T12:00:00Z',
          updatedAt: '2026-05-18T12:00:00Z',
        },
      },
    }), 'utf8');
    await writeFile(join(appSupportDirectory, 'projection-baselines.json'), JSON.stringify({
      schemaVersion: 1,
      baselines: {
        [canonicalMarkdownPath]: {
          schemaVersion: 1,
          lastProjectedMarkdown: localMarkdown,
          lastProjectedHash: localHash,
          lastProviderStateFingerprint: `provider-ytext:${localHash}`,
          updatedAt: '2026-05-18T12:00:00Z',
        },
      },
    }), 'utf8');

    const env = {
      MARKLAB_APP_SUPPORT_DIR: appSupportDirectory,
      MARKLAB_CONTROL_PLANE_API_URL: exportServer.apiUrl,
      MARKLAB_USER_TOKEN: 'ml_user_session_test',
    };

    try {
      const status = await runCli(['status', markdownPath, '--json'], env, 30000);
      expectCliOk(status);
      expect(JSON.parse(status.stdout)).toMatchObject({
        ok: true,
        path: canonicalMarkdownPath,
        shared: true,
        syncState: 'provider_pending',
        observedHash: localHash,
        providerVerification: {
          status: 'pending',
          exportedHash: markdownHash(staleRemoteMarkdown),
        },
      });

      const wait = await runCli(['wait', markdownPath, '--synced', '--json', '--timeout', '25'], env, 30000);
      expect(wait.code).toBe(6);
      expect(JSON.parse(wait.stdout)).toMatchObject({
        ok: false,
        code: 'sync_timeout',
        details: {
          syncState: 'provider_pending',
          observedHash: localHash,
        },
      });
    } finally {
      await exportServer.close().catch(() => undefined);
    }

    const matchedExportServer = await startNativeExportServer(new Map([
      ['doc_native:branch_native', localMarkdown],
    ]));
    try {
      const matched = await runCli(['status', markdownPath, '--json'], {
        ...env,
        MARKLAB_CONTROL_PLANE_API_URL: matchedExportServer.apiUrl,
      }, 30000);
      expectCliOk(matched);
      expect(JSON.parse(matched.stdout)).toMatchObject({
        ok: true,
        syncState: 'synced',
        providerVerification: {
          status: 'verified',
          exportedHash: localHash,
        },
      });
    } finally {
      await matchedExportServer.close();
    }
  });

  it('uses the bound access token for provider verification before shell user tokens', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'marklab-cli-native-binding-token-'));
    const appSupportDirectory = join(directory, 'app-support');
    await mkdir(appSupportDirectory, { recursive: true });
    const markdownPath = join(directory, 'joined.md');
    const markdown = '# Joined provider token\n';
    await writeFile(markdownPath, markdown, 'utf8');
    const canonicalMarkdownPath = await realpath(markdownPath);
    const hash = markdownHash(markdown);
    const exportServer = await startNativeExportServer(new Map([
      ['doc_joined:branch_main', markdown],
    ]), {
      authorize: (req) => req.headers.authorization === 'Bearer ml_access_edit',
    });

    await writeFile(join(appSupportDirectory, 'shared-document-bindings.json'), JSON.stringify({
      schemaVersion: 1,
      bindings: {
        [canonicalMarkdownPath]: {
          schemaVersion: 1,
          filePath: canonicalMarkdownPath,
          docId: 'doc_joined',
          branchId: 'branch_main',
          mode: 'edit',
          token: 'ml_access_edit',
          appEditorURL: 'https://app.example.test/collab?docId=doc_joined&branchId=branch_main&mode=edit&clientKind=app&nativeShell=markedit',
          localDocId: 'local_joined',
          baselineHash: hash,
          createdAt: '2026-05-18T12:00:00Z',
          updatedAt: '2026-05-18T12:00:00Z',
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
          updatedAt: '2026-05-18T12:00:00Z',
        },
      },
    }), 'utf8');

    try {
      const status = await runCli(['status', markdownPath, '--json'], {
        MARKLAB_APP_SUPPORT_DIR: appSupportDirectory,
        MARKLAB_CONTROL_PLANE_API_URL: exportServer.apiUrl,
        MARKLAB_USER_TOKEN: 'ml_user_wrong',
      }, 30000);
      expectCliOk(status);
      expect(JSON.parse(status.stdout)).toMatchObject({
        ok: true,
        path: canonicalMarkdownPath,
        shared: true,
        syncState: 'synced',
        providerVerification: {
          status: 'verified',
          exportedHash: hash,
        },
        binding: {
          hasAccessToken: true,
        },
      });
      expect(exportServer.requests.map((request) => request.authorization)).toEqual([
        'Bearer ml_access_edit',
      ]);
    } finally {
      await exportServer.close();
    }
  });

  it('keeps newly joined shared files pending until a projection baseline exists', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'marklab-cli-native-join-pending-'));
    const appSupportDirectory = join(directory, 'app-support');
    await mkdir(appSupportDirectory, { recursive: true });
    const markdownPath = join(directory, 'joined.md');
    await writeFile(markdownPath, '', 'utf8');
    const canonicalMarkdownPath = await realpath(markdownPath);

    await writeFile(join(appSupportDirectory, 'shared-document-bindings.json'), JSON.stringify({
      schemaVersion: 1,
      bindings: {
        [canonicalMarkdownPath]: {
          schemaVersion: 1,
          filePath: canonicalMarkdownPath,
          docId: 'doc_joined',
          branchId: 'branch_main',
          mode: 'edit',
          token: 'ml_access_edit',
          appEditorURL: 'https://app.example.test/collab?docId=doc_joined&branchId=branch_main&mode=edit&clientKind=app&nativeShell=markedit',
          localDocId: 'local_joined',
          baselineHash: markdownHash(''),
          createdAt: '2026-05-18T12:00:00Z',
          updatedAt: '2026-05-18T12:00:00Z',
        },
      },
    }), 'utf8');

    const env = { MARKLAB_APP_SUPPORT_DIR: appSupportDirectory };
    const status = await runCli(['status', markdownPath, '--json'], env, 30000);
    expectCliOk(status);
    expect(JSON.parse(status.stdout)).toMatchObject({
      ok: true,
      path: canonicalMarkdownPath,
      shared: true,
      syncState: 'pending',
      baseline: null,
    });

    const wait = await runCli(['wait', markdownPath, '--synced', '--json', '--timeout', '25'], env, 30000);
    expect(wait.code).toBe(6);
    expect(JSON.parse(wait.stdout)).toMatchObject({
      ok: false,
      code: 'sync_timeout',
      details: {
        syncState: 'pending',
        observedHash: markdownHash(''),
      },
    });
  });

  it('parses current native commands only', () => {
    expect(parseCliArgs(['open', 'README.md'])).toEqual({
      command: 'open',
      file: 'README.md',
      json: false,
      background: false,
    });
    expect(parseCliArgs(['status'])).toEqual({ command: 'status', file: null, json: false });
    expect(parseCliArgs(['share', 'README.md', '--view'])).toEqual({
      command: 'share',
      file: 'README.md',
      json: false,
      daemonOnly: false,
      shareRole: 'view',
    });
    expect(parseCliArgs(['join', 'https://example.test/collab?docId=d&branchId=b&token=t&mode=edit', '--dir', './docs', '--name', 'shared.md', '--create-dir'])).toEqual({
      command: 'join',
      link: 'https://example.test/collab?docId=d&branchId=b&token=t&mode=edit',
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
  });

  it('normalizes hosted join filenames and rejects path traversal names', () => {
    expect(safeJoinFilename('shared-notes')).toBe('shared-notes.md');
    expect(safeJoinFilename('README.md')).toBe('README.md');
    expect(() => safeJoinFilename('../README.md')).toThrow('--name must be a Markdown filename');
    expect(() => safeJoinFilename('nested/README.md')).toThrow('--name must be a Markdown filename');
  });

  it('supports test-controlled folder picking without opening a native picker', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'marklab-cli-pick-dir-'));
    await expect(pickJoinDirectory({ MARKLAB_PICK_DIR_FOR_TEST: directory }, 'darwin')).resolves.toBe(resolve(directory));
  });
});
