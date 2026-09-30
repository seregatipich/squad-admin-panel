// @vitest-environment happy-dom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@squad/shared-config/mark-types', async (importOriginal) => {
  const original = await importOriginal<typeof import('@squad/shared-config/mark-types')>();
  return {
    ...original,
    MARK_TYPE_ICONS: [...original.MARK_TYPE_ICONS, 'icon-added-in-api'],
    MARK_TYPE_SEVERITY_MAX: 7,
  };
});

import MarkTypesPage from './page';

const TEST_TIMEOUT_MS = 15_000;

function mockFetch() {
  return vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/api/v1/me')) {
      return Promise.resolve(
        new Response(JSON.stringify({ permissions: ['role:edit'] }), { status: 200 }),
      );
    }
    if (url.includes('/api/v1/mark-types')) {
      return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('MarkTypesPage shared constants (#718)', () => {
  it(
    'builds the icon and severity options from @squad/shared-config instead of a local copy',
    async () => {
      vi.stubGlobal('fetch', mockFetch());
      render(<MarkTypesPage />);
      await screen.findByLabelText('Идентификатор (лат.)');

      const icons = within(screen.getByLabelText('Иконка')).getAllByRole('option');
      expect(icons.map((option) => option.getAttribute('value'))).toContain('icon-added-in-api');

      const severities = within(screen.getByLabelText('Тяжесть')).getAllByRole('option');
      expect(severities).toHaveLength(7);
    },
    TEST_TIMEOUT_MS,
  );
});
