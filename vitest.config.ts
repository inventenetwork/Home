import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Each test boots an in-memory Postgres (WASM); allow time on slower machines.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
