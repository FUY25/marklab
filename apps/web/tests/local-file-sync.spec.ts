import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function waitForHttp(url: string, timeoutMs = 30000): Promise<void> {
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
      request.setTimeout(1000, () => request.destroy());
    }
    attempt();
  });
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  return new Promise((resolvePort, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('missing_port'));
        return;
      }
      const port = address.port;
      server.close(() => resolvePort(port));
    });
  });
}

function spawnPnpm(args: string[], env: Record<string, string>): ChildProcess {
  const child = spawn('npx', ['-y', 'pnpm@10.0.0', ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', () => undefined);
  child.stderr?.on('data', () => undefined);
  return child;
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (child.pid) process.kill(-child.pid, 'SIGTERM');
    else child.kill('SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  await Promise.race([
    new Promise((resolveWait) => child.once('exit', resolveWait)),
    new Promise((resolveWait) => setTimeout(resolveWait, 5000)),
  ]);
}

async function startLocalStack() {
  const directory = await mkdtemp(join(tmpdir(), 'marklab-local-e2e-'));
  const file = join(directory, 'local-e2e.md');
  const metadataPath = join(directory, 'metadata.json');
  await writeFile(file, '# Local E2E\n\nInitial paragraph.\n', 'utf8');

  const apiPort = await freePort();
  const webPort = await freePort();
  const token = 'local-e2e-token';
  const apiUrl = `http://127.0.0.1:${apiPort}`;
  const webUrl = `http://127.0.0.1:${webPort}`;
  const localUrl = `${webUrl}/local#token=${encodeURIComponent(token)}`;

  const api = spawnPnpm(['--filter', '@marklab/api', 'start'], {
    PORT: String(apiPort),
    MARKLAB_HOST: '127.0.0.1',
    MARKLAB_LOCAL_FILE: file,
    MARKLAB_LOCAL_TOKEN: token,
    MARKLAB_LOCAL_METADATA_PATH: metadataPath,
    MARKLAB_WEB_ORIGIN: webUrl,
    MARKLAB_REQUIRE_AUTH: 'false',
  });
  const web = spawnPnpm(
    ['--filter', '@marklab/web', 'exec', 'vite', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'],
    {
      VITE_MARKLAB_API_URL: apiUrl,
      VITE_MARKLAB_WS_URL: `ws://127.0.0.1:${apiPort}/collab`,
    },
  );

  await Promise.all([waitForHttp(`${apiUrl}/healthz`), waitForHttp(webUrl)]);
  return {
    file,
    token,
    apiUrl,
    webUrl,
    localUrl,
    stop: async () => {
      await stopChild(api);
      await stopChild(web);
    },
  };
}

async function installWebSocketCounter(page: Page) {
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    let webSocketCount = 0;
    window.WebSocket = class CountingWebSocket extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        webSocketCount += 1;
        if (protocols === undefined) {
          super(url);
        } else {
          super(url, protocols);
        }
      }
    };
    Object.defineProperty(window, '__marklabWebSocketCount', {
      value: () => webSocketCount,
    });
  });
}

async function webSocketCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const win = window as typeof window & { __marklabWebSocketCount?: () => number };
    if (!win.__marklabWebSocketCount) throw new Error('websocket_counter_missing');
    return win.__marklabWebSocketCount();
  });
}

test('syncs one local Markdown file across disk, browser windows, snapshots, and conflict state', async ({ browser }) => {
  test.setTimeout(90000);
  const stack = await startLocalStack();
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();

  try {
    const pageA = await contextA.newPage();
    await installWebSocketCounter(pageA);
    await pageA.goto(stack.localUrl);
    const editorA = pageA.getByTestId('milkdown-editor').locator('.ProseMirror');
    await expect(editorA).toContainText('Local E2E');
    await expect(pageA.getByText('Connected to local file')).toBeVisible();
    const initialPageAWebSocketCount = await webSocketCount(pageA);

    await pageA.waitForTimeout(3600);
    expect(await webSocketCount(pageA)).toBe(initialPageAWebSocketCount);

    await editorA.click();
    await pageA.keyboard.press(`${modifier}+End`);
    await pageA.keyboard.press('Enter');
    await pageA.keyboard.type('Browser edit writes to disk.');
    await expect.poll(async () => readFile(stack.file, 'utf8')).toContain('Browser edit writes to disk.');

    await writeFile(stack.file, '# Local E2E\n\nExternal file save updates browser.\n', 'utf8');
    await expect(editorA).toContainText('External file save updates browser.');

    const pageB = await contextB.newPage();
    await pageB.goto(stack.localUrl);
    const editorB = pageB.getByTestId('milkdown-editor').locator('.ProseMirror');
    await expect(editorB).toContainText('External file save updates browser.');

    await editorA.click();
    await pageA.keyboard.press(`${modifier}+End`);
    await pageA.keyboard.press('Enter');
    await pageA.keyboard.type('Second browser sees this.');
    await expect(editorB).toContainText('Second browser sees this.');
    await expect.poll(async () => readFile(stack.file, 'utf8')).toContain('Second browser sees this.');

    await pageA.getByRole('button', { name: 'Versions' }).click();
    await pageA.getByRole('button', { name: 'Save snapshot' }).click();
    await expect(pageA.getByText(/Saved snapshot v/u)).toBeVisible();
    const afterSnapshotPageAWebSocketCount = await webSocketCount(pageA);
    expect(afterSnapshotPageAWebSocketCount).toBe(initialPageAWebSocketCount);
    await pageA.waitForTimeout(1800);
    await expect(pageA.getByText(/Saved snapshot v/u)).toBeVisible();
    expect(await webSocketCount(pageA)).toBe(afterSnapshotPageAWebSocketCount);

    await writeFile(stack.file, '# Local E2E\n\nChanged after snapshot.\n', 'utf8');
    await expect(editorA).toContainText('Changed after snapshot.');
    await expect(editorB).toContainText('Changed after snapshot.');

    await pageA.getByRole('button', { name: 'Restore' }).click();
    await expect.poll(async () => readFile(stack.file, 'utf8')).toContain('Second browser sees this.');
    await expect(editorA).toContainText('Second browser sees this.');
    await expect(editorB).toContainText('Second browser sees this.');
    await pageA.getByLabel('Close versions').click();

    await editorA.click();
    await pageA.keyboard.press(`${modifier}+End`);
    await pageA.keyboard.press('Enter');
    await pageA.keyboard.type('Browser conflict draft.');
    await writeFile(stack.file, '# Local E2E\n\nExternal conflicting save stays on disk.\n', 'utf8');
    await expect(
      pageA.getByTestId('local-conflict-paused').getByText('File changed outside MarkLab. Review needed.'),
    ).toBeVisible({ timeout: 10000 });
    await expect.poll(async () => readFile(stack.file, 'utf8')).toContain('External conflicting save stays on disk.');
  } finally {
    await Promise.allSettled([contextA.close(), contextB.close()]);
    await stack.stop();
  }
});

test('consumes a local daemon token added to an already open local tab', async ({ page }) => {
  test.setTimeout(60000);
  const stack = await startLocalStack();

  try {
    await page.goto(`${stack.webUrl}/local`);
    await expect(page.getByRole('alert')).toContainText('Open a Markdown file with marklab open README.md.');

    await page.evaluate((url) => {
      window.location.href = url;
    }, stack.localUrl);

    const editor = page.getByTestId('milkdown-editor').locator('.ProseMirror');
    await expect(editor).toContainText('Local E2E');
    await expect(page.getByText('Connected to local file')).toBeVisible();
  } finally {
    await stack.stop();
  }
});
