import { defineConfig } from 'vitest/config';

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
  },
});
