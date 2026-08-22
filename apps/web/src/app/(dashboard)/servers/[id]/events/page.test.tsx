// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { Suspense } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/servers/abc/events'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

/**
 * Обозреватель событий подменён компонентом, который навсегда остаётся в
 * состоянии загрузки: только так тест видит именно заглушку `Suspense`, ради
 * которой страница и существует.
 */
const NEVER = new Promise<never>(() => {});
vi.mock('../../../events/EventsBrowser', () => ({
  EventsBrowser: () => {
    throw NEVER;
  },
}));

import ServerEventsPage from './page';

afterEach(cleanup);

describe('ServerEventsPage', () => {
  it('is a valid React component', () => {
    expect(ServerEventsPage).toBeDefined();
    expect(typeof ServerEventsPage).toBe('function');
  });

  it('объявляет загрузку заглушкой в форме списка, а не строкой текста', async () => {
    await act(async () => {
      render(
        <Suspense fallback={null}>
          <ServerEventsPage params={Promise.resolve({ id: 'abc' })} />
        </Suspense>,
      );
    });

    expect(screen.getByRole('status')).toHaveTextContent('Загружаем журнал событий');
    expect(screen.queryByText('Загрузка…')).not.toBeInTheDocument();
  });
});
