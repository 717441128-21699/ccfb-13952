import { defineConfig } from 'vitest/config';

export default defineConfig({
  worker: {
    format: 'es',
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 60_000,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
