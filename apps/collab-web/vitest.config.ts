import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    // Per-file `// @vitest-environment jsdom` directives still apply.
    // setupFiles runs for every test file regardless of environment; the
    // shim early-returns when `window` is missing (node-env tests).
    setupFiles: ['./vitest.setup.ts'],
  },
});
