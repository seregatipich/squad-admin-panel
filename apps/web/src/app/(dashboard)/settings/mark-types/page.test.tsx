// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MarkTypesPage from './page';

const TEST_TIMEOUT_MS = 15_000;

const MARK_TYPE = {
  id: 1,
  slug: 'ghost_peek',
  label_en: 'Ghost peek',
  label_ru: 'Гост-пик',
  icon: '👀',
  severity: 3,
  is_active: true,
  sort_order: 1,
};

function mockFetch(opts: { permissions?: string[]; types?: unknown[] } = {}) {
  const permissions = opts.permissions ?? ['role:edit'];
  const types = opts.types ?? [MARK_TYPE];
  return vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith('/api/v1/me')) {
      return Promise.resolve(new Response(JSON.stringify({ permissions }), { status: 200 }));
    }
    if (url.includes('/api/v1/mark-types')) {
      return Promise.resolve(new Response(JSON.stringify(types), { status: 200 }));
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('MarkTypesPage', () => {
  it('is a valid React component', () => {
    expect(MarkTypesPage).toBeDefined();
    expect(typeof MarkTypesPage).toBe('function');
  });

  it(
    'renders the taxonomy table and the create form for an editor',
    async () => {
      vi.stubGlobal('fetch', mockFetch());
      render(<MarkTypesPage />);
      expect(await screen.findByRole('heading', { name: 'Типы меток' })).toBeInTheDocument();
      expect(await screen.findByText('ghost_peek')).toBeInTheDocument();
      expect(screen.getByRole('columnheader', { name: 'Идентификатор' })).toBeInTheDocument();
      expect(screen.getByLabelText('Идентификатор (лат.)')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Деактивировать' })).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'shows the empty state and hides mutating controls without role:edit',
    async () => {
      vi.stubGlobal('fetch', mockFetch({ permissions: [], types: [] }));
      render(<MarkTypesPage />);
      expect(await screen.findByText('Типов пока нет')).toBeInTheDocument();
      expect(screen.queryByLabelText('Идентификатор (лат.)')).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );
});
