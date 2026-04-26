import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', 'test/role-colors.test.ts'],
    testTimeout: 10_000,
  },
});
