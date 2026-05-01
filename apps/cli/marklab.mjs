#!/usr/bin/env node
import { spawn } from 'node:child_process';
import http from 'node:http';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const command = args[0];

function printUsage() {
  console.log('Usage: marklab open <file.md>');
}

function waitForHttp(url, timeoutMs = 30000) {
  const startedAt = Date.now();
  return new Promise((resolveWait, rejectWait) => {
    function attempt() {
      const request = http.get(url, (response) => {
        response.resume();
        resolveWait();
      });
      request.on('error', () => {
        if (Date.now() - startedAt > timeoutMs) {
          rejectWait(new Error(`Timed out waiting for ${url}`));
          return;
        }
        setTimeout(attempt, 350);
      });
      request.setTimeout(1000, () => {
        request.destroy();
      });
    }
    attempt();
  });
}

function spawnPnpm(argsToRun, env) {
  return spawn('npx', ['-y', 'pnpm@10.0.0', ...argsToRun], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: 'inherit',
  });
}

function openBrowser(url) {
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

if (command !== 'open' || !args[1]) {
  printUsage();
  process.exit(command ? 1 : 0);
}

const markdownPath = resolve(args[1]);
if (!existsSync(markdownPath)) {
  console.error(`File not found: ${markdownPath}`);
  process.exit(1);
}

const apiPort = process.env.MARKLAB_API_PORT ?? '3011';
const webPort = process.env.MARKLAB_WEB_PORT ?? '5175';
const apiUrl = `http://127.0.0.1:${apiPort}`;
const webUrl = `http://127.0.0.1:${webPort}`;
const localUrl = `${webUrl}/local`;

const children = [
  spawnPnpm(['--filter', '@marklab/api', 'dev'], {
    PORT: apiPort,
    MARKLAB_LOCAL_FILE: markdownPath,
    MARKLAB_REQUIRE_AUTH: 'false',
  }),
  spawnPnpm(['--filter', '@marklab/web', 'dev', '--host', '127.0.0.1', '--port', webPort], {
    VITE_MARKLAB_API_URL: apiUrl,
    VITE_MARKLAB_WS_URL: `ws://127.0.0.1:${apiPort}/collab`,
  }),
];

function shutdown() {
  for (const child of children) child.kill('SIGTERM');
}

process.on('SIGINT', () => {
  shutdown();
  process.exit(130);
});
process.on('SIGTERM', () => {
  shutdown();
  process.exit(143);
});
process.on('exit', shutdown);

void Promise.all([waitForHttp(`${apiUrl}/healthz`), waitForHttp(webUrl)])
  .then(() => {
    console.log(`Opening ${localUrl}`);
    openBrowser(localUrl);
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
  });
