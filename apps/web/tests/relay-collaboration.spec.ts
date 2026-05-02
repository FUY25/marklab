import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

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
  return spawn('npx', ['-y', 'pnpm@10.0.0', ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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

interface RelayStackOptions {
  publicWebUrl?: string;
}

async function startRelayStack(options: RelayStackOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'marklab-relay-e2e-'));
  const file = join(directory, 'README.md');
  const metadataPath = join(directory, 'metadata.json');
  await writeFile(file, '# Relay E2E\n\nOriginal paragraph.\n', 'utf8');

  const apiPort = await freePort();
  const webPort = await freePort();
  const token = 'relay-local-token';
  const apiUrl = `http://127.0.0.1:${apiPort}`;
  const webUrl = `http://127.0.0.1:${webPort}`;
  const relayWsUrl = `ws://127.0.0.1:${apiPort}/relay`;
  const publicWebUrl = options.publicWebUrl ?? webUrl;

  const api = spawnPnpm(['--filter', '@marklab/api', 'start'], {
    PORT: String(apiPort),
    MARKLAB_HOST: '127.0.0.1',
    MARKLAB_LOCAL_FILE: file,
    MARKLAB_LOCAL_TOKEN: token,
    MARKLAB_LOCAL_METADATA_PATH: metadataPath,
    MARKLAB_ENABLE_RELAY: 'true',
    MARKLAB_WEB_ORIGIN: webUrl,
    MARKLAB_PUBLIC_WEB_URL: publicWebUrl,
    MARKLAB_PUBLIC_API_URL: apiUrl,
    MARKLAB_PUBLIC_RELAY_WS_URL: relayWsUrl,
    MARKLAB_RELAY_WS_URL: relayWsUrl,
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
  const localDocumentResponse = await fetch(`${apiUrl}/api/local/document`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!localDocumentResponse.ok) {
    throw new Error(`local document prime failed: ${await localDocumentResponse.text()}`);
  }

  async function createRelayLink(role: 'view' | 'edit'): Promise<string> {
    const response = await fetch(`${apiUrl}/api/local/access-grants`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ role }),
    });
    if (!response.ok) throw new Error(`create ${role} link failed: ${await response.text()}`);
    const body = (await response.json()) as { url: string };
    return body.url;
  }

  return {
    file,
    localToken: token,
    webUrl,
    createRelayLink,
    stop: async () => {
      await stopChild(api);
      await stopChild(web);
    },
  };
}

test('local Share creates hosted relay links without leaking local daemon access', async ({ page }) => {
  test.setTimeout(90000);
  const stack = await startRelayStack({ publicWebUrl: 'https://marklab-relay-alpha.example.test' });

  try {
    await page.goto(`${stack.webUrl}/local#token=${stack.localToken}`);
    await expect(page.getByTestId('local-document-page')).toBeVisible();
    await page.getByRole('button', { name: 'Share' }).click();
    await expect(page.getByTestId('share-drawer')).toBeVisible();
    await page.getByRole('button', { name: 'Create link' }).click();

    const createdUrl = await page.getByTestId('created-access-url').textContent();
    expect(createdUrl).toBeTruthy();
    expect(createdUrl).toContain('https://marklab-relay-alpha.example.test/relay/');
    expect(createdUrl).toContain('token=ml_relay_');
    expect(createdUrl).toContain('mode=view');
    expect(createdUrl).not.toContain('relay-local-token');
    expect(createdUrl).not.toContain('localToken=');
    expect(createdUrl).not.toContain('localDaemonToken=');
    expect(createdUrl).not.toContain('#token=');
    expect(createdUrl).not.toContain(stack.webUrl);
  } finally {
    await stack.stop();
  }
});

test('edit relay browser joins by link and writes through the host local file', async ({ page }) => {
  test.setTimeout(90000);
  const stack = await startRelayStack();

  try {
    const editUrl = await stack.createRelayLink('edit');
    await page.goto(editUrl);
    const dialog = page.getByRole('dialog', { name: 'Name for collaboration' });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Collaborator name').fill('Browser collaborator');
    await dialog.getByRole('button', { name: 'Continue', exact: true }).click();

    const editor = page.getByTestId('milkdown-editor').locator('.ProseMirror');
    await expect(editor).toContainText('Relay E2E');
    await editor.click();
    await page.keyboard.press(`${modifier}+End`);
    await page.keyboard.press('Enter');
    await page.keyboard.type('Relay browser edit writes to host file.');

    await expect.poll(async () => readFile(stack.file, 'utf8')).toContain('Relay browser edit writes to host file.');
  } finally {
    await stack.stop();
  }
});

test('view relay browser opens read-only and never creates an edit provider', async ({ page }) => {
  test.setTimeout(90000);
  const stack = await startRelayStack();

  try {
    const viewUrl = await stack.createRelayLink('view');
    const sessionRequests: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/access-sessions')) sessionRequests.push(request.url());
    });
    await page.goto(viewUrl);

    await expect(page.getByTestId('relay-document-page')).toBeVisible();
    await expect(page.getByText('Relay E2E')).toBeVisible();
    await expect(page.getByTestId('milkdown-editor')).toHaveCount(0);
    await expect(page.getByRole('dialog', { name: 'Name for collaboration' })).toHaveCount(0);
    expect(sessionRequests).toEqual([]);
  } finally {
    await stack.stop();
  }
});
