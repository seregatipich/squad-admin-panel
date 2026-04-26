import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/security/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 300_000,
    fileParallelism: false,
    sequence: { concurrent: false },
    reporters: ['verbose'],
  },
});
