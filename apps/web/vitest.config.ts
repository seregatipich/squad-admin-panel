import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: {
    jsx: 'automatic',
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', 'e2e/**', '**/.next/**', 'test/e2e/**'],
    passWithNoTests: true,
    // jest-dom matchers and the <dialog> polyfill, loaded once per test file
    // instead of being imported/copied by each file.
    setupFiles: ['./src/test-setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.test.tsx',
        'src/**/*.d.ts',
        'src/**/types.ts',
        'src/test-setup.ts',
      ],
      thresholds: {
        lines: 1,
        functions: 17,
        branches: 83,
        statements: 1,
      },
      reportsDirectory: './coverage',
    },
  },
});
