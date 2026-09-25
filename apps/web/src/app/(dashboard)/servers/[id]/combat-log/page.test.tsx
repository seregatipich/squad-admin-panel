// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { Suspense } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/servers/abc/combat-log'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

/**
 * Боевой лог подменён компонентом, который навсегда остаётся в состоянии
 * загрузки: только так тест видит именно заглушку `Suspense`, ради которой
 * страница и существует.
 */
const NEVER = new Promise<never>(() => {});
vi.mock('../../../combat-log/CombatLog', () => ({
  CombatLog: () => {
    throw NEVER;
  },
}));

import ServerCombatLogPage from './page';

afterEach(cleanup);

describe('ServerCombatLogPage', () => {
  it('is a valid React component', () => {
    expect(ServerCombatLogPage).toBeDefined();
    expect(typeof ServerCombatLogPage).toBe('function');
  });

  it('объявляет загрузку заглушкой в форме списка, а не строкой текста', async () => {
    await act(async () => {
      render(
        <Suspense fallback={null}>
          <ServerCombatLogPage params={Promise.resolve({ id: 'abc' })} />
        </Suspense>,
      );
    });

    expect(screen.getByRole('status')).toHaveTextContent('Загружаем боевой лог');
    expect(screen.queryByText('Загрузка…')).not.toBeInTheDocument();
  });
});
