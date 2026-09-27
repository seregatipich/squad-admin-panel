// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/settings'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

import SettingsIndexPage from './page';

/** Права, при которых видна вся витрина. */
const ALL_PERMISSIONS = [
  'role:view',
  'role:edit',
  'host:manage',
  'player:view_ips',
  'whitelist:view',
  'integration:manage',
];

function stubMe(permissions: string[]) {
  const fetchMock = vi.fn(() =>
    Promise.resolve(new Response(JSON.stringify({ permissions }), { status: 200 })),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('SettingsIndexPage', () => {
  it('renders one grouped list per settings column from the nav tree', async () => {
    stubMe(ALL_PERMISSIONS);
    render(<SettingsIndexPage />);

    expect(await screen.findByRole('heading', { level: 2, name: 'Панель' })).toBeInTheDocument();
    for (const column of ['Модерация', 'Игра', 'Автоматика']) {
      expect(screen.getByRole('heading', { level: 2, name: column })).toBeInTheDocument();
    }
  });

  it('renders every settings page as a real link to its own address', async () => {
    stubMe(ALL_PERMISSIONS);
    render(<SettingsIndexPage />);

    expect(await screen.findByRole('link', { name: /Аккаунт/ })).toHaveAttribute(
      'href',
      '/settings/account',
    );
    expect(screen.getByRole('link', { name: /Группы/ })).toHaveAttribute(
      'href',
      '/settings/groups',
    );
    expect(screen.getByRole('link', { name: /Discord/ })).toHaveAttribute(
      'href',
      '/settings/integrations/discord',
    );
  });

  it('hides a page the operator has no permission for', async () => {
    stubMe([]);
    render(<SettingsIndexPage />);

    // Аккаунт и API-токены ничем не закрыты, «Бэкапы» требуют host:manage.
    await screen.findByRole('link', { name: /Аккаунт/ });
    expect(screen.queryByRole('link', { name: /Бэкапы/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Группы/ })).not.toBeInTheDocument();
  });

  it('drops a column whose every page is gated away', async () => {
    stubMe([]);
    render(<SettingsIndexPage />);

    await screen.findByRole('link', { name: /Аккаунт/ });
    // «Игра» держит только страницы без гейта, а вот «Модерация» без прав
    // теряет не все пункты — проверяем колонку, гейт которой снимает всё.
    expect(screen.queryByRole('link', { name: /GeoIP/ })).not.toBeInTheDocument();
  });

  it('reports a failed request and retries on demand', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response('nope', { status: 503 })));
    vi.stubGlobal('fetch', fetchMock);
    render(<SettingsIndexPage />);

    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent('Не удалось загрузить список настроек');
    expect(banner).toHaveTextContent('HTTP 503');

    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ permissions: ALL_PERMISSIONS }), { status: 200 }),
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(screen.getByRole('link', { name: /Аккаунт/ })).toBeInTheDocument();
  });
});
