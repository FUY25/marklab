import { defineConfig } from 'vitest/config';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    include: [
      'packages/**/*.test.ts',
      'packages/**/*.test.tsx',
      'apps/**/*.test.ts',
      'apps/**/*.test.tsx',
      'apps/**/*.test.mjs',
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
    ],
    environment: 'node',
    // The collab-web localStorage shim must apply when tests are run from
    // the repo root as well as via `pnpm --filter @marklab/collab-web test`.
    // The shim early-returns when `window` is undefined, so it is a no-op
    // for node-environment tests.
    setupFiles: [resolve(repoRoot, 'apps/collab-web/vitest.setup.ts')],
  },
});
