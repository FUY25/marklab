import { createHash } from 'node:crypto';
import { defineConfig } from '@playwright/test';
import {
  rejectManagedUrlOverrides,
  requireLocalHttpUrl,
  requireLocalWebsocketUrl,
} from './tests/setup-remote-api';

const port = 5175;
const baseURL = `http://127.0.0.1:${port}`;
const apiPort = 3011;
const defaultApiUrl = `http://127.0.0.1:${apiPort}`;
const allowExistingApi = process.env.MARKLAB_E2E_ALLOW_EXISTING_API === 'true';
rejectManagedUrlOverrides();
const shouldStartApi = Boolean(process.env.TEST_DATABASE_URL) && !allowExistingApi;
const usesRemoteE2E = shouldStartApi || allowExistingApi;
const apiUrl = shouldStartApi ? defaultApiUrl : process.env.MARKLAB_E2E_API_URL ?? defaultApiUrl;
const websocketUrl =
  process.env.MARKLAB_E2E_WS_URL ?? `${apiUrl.replace(/^http/u, 'ws').replace(/\/+$/u, '')}/collab`;
const e2eAdminToken = process.env.MARKLAB_E2E_ADMIN_TOKEN ?? 'marklab-e2e-admin-token';
const e2eAdminTokenHash =
  process.env.MARKLAB_ADMIN_TOKEN_HASH ??
  `sha256:${createHash('sha256').update(e2eAdminToken, 'utf8').digest('hex')}`;

if (allowExistingApi) {
  requireLocalHttpUrl(apiUrl, 'MARKLAB_E2E_API_URL');
  requireLocalWebsocketUrl(websocketUrl, 'MARKLAB_E2E_WS_URL');
}

export default defineConfig({
  testDir: './tests',
  ...(shouldStartApi ? { workers: 1 } : {}),
  use: {
    baseURL,
  },
  webServer: [
    {
      command: `cd ../.. && VITE_MARKLAB_API_URL=${apiUrl} VITE_MARKLAB_WS_URL=${websocketUrl} pnpm --filter @marklab/web exec vite --host 127.0.0.1 --port ${port} --strictPort`,
      url: baseURL,
      reuseExistingServer: !usesRemoteE2E,
    },
    ...(shouldStartApi
      ? [
          {
            command: `cd ../.. && DATABASE_URL="$TEST_DATABASE_URL" PORT=${apiPort} MARKLAB_ADMIN_TOKEN_HASH=${e2eAdminTokenHash} pnpm --dir apps/api exec tsx -e "const events = new EventTarget(); globalThis.addEventListener = events.addEventListener.bind(events); globalThis.removeEventListener = events.removeEventListener.bind(events); globalThis.dispatchEvent = events.dispatchEvent.bind(events); import('./src/index.ts').catch((error) => { console.error(error); process.exit(1); });"`,
            url: `${defaultApiUrl}/healthz`,
            reuseExistingServer: false,
          },
        ]
      : []),
  ],
});
