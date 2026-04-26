import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('setup wizard removed', () => {
  it('apps/api/src/server.ts no longer imports setupRoutes', () => {
    const serverPath = resolve(__dirname, '../src/server.ts');
    const source = readFileSync(serverPath, 'utf-8');
    expect(source).not.toMatch(/setupRoutes/);
    expect(source).not.toMatch(/routes\/setup/);
  });

  it('apps/api/src/routes/setup.ts no longer exists', () => {
    expect(() => {
      readFileSync(resolve(__dirname, '../src/routes/setup.ts'), 'utf-8');
    }).toThrow();
  });
});
