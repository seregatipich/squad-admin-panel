import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Playwright specs live under e2e/*.spec.ts; they use @playwright/test,
    // not vitest. Run them via `pnpm --filter @squad/web test:e2e`.
    exclude: ['**/node_modules/**', '**/dist/**', 'e2e/**', '.next/**'],
    passWithNoTests: true,
  },
});
