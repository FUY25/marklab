import { defineConfig } from '@playwright/test';

const port = 5175;
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests',
  globalSetup: './tests/setup-remote-api.ts',
  use: {
    baseURL,
  },
  webServer: [
    {
      command: `cd ../.. && VITE_MARKLAB_API_URL=http://127.0.0.1:3001 VITE_MARKLAB_WS_URL=ws://127.0.0.1:3001/collab pnpm --filter @marklab/web exec vite --host 127.0.0.1 --port ${port} --strictPort`,
      url: baseURL,
      reuseExistingServer: true,
    },
    {
      command:
        'cd ../.. && DATABASE_URL="$TEST_DATABASE_URL" PORT=3001 pnpm --dir apps/api exec tsx -e "const events = new EventTarget(); globalThis.addEventListener = events.addEventListener.bind(events); globalThis.removeEventListener = events.removeEventListener.bind(events); globalThis.dispatchEvent = events.dispatchEvent.bind(events); import(\'./src/index.ts\').catch((error) => { console.error(error); process.exit(1); });"',
      url: 'http://127.0.0.1:3001/healthz',
      reuseExistingServer: true,
    },
  ],
});
