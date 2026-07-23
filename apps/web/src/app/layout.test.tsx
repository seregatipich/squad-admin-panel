import { describe, expect, it, vi } from 'vitest';

const cookieStore = { value: undefined as string | undefined };

vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) =>
        name === 'locale' && cookieStore.value !== undefined
          ? { value: cookieStore.value }
          : undefined,
    }),
}));

import RootLayout, { generateMetadata } from './layout';

describe('RootLayout', () => {
  it('is a valid React component', () => {
    expect(RootLayout).toBeDefined();
    expect(typeof RootLayout).toBe('function');
  });
});

describe('generateMetadata', () => {
  it('localizes the title/description in Russian by default', async () => {
    cookieStore.value = undefined;
    const meta = await generateMetadata();
    expect(meta.title).toBe('Squad Admin Panel');
    expect(meta.description).toBe(
      'Опенсорсная self-hosted админ-панель для выделенных серверов Squad',
    );
  });

  it('localizes the description in English when the locale cookie is en', async () => {
    cookieStore.value = 'en';
    const meta = await generateMetadata();
    expect(meta.description).toBe(
      'Open-source self-hosted admin panel for Squad dedicated servers',
    );
  });
});
