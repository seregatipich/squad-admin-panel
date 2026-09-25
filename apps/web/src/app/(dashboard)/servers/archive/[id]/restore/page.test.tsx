// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { Suspense } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/servers/archive/abc/restore'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));
vi.mock('@/components/LogConsole', () => ({ LogConsole: () => null }));

import RestorePage from './page';

function mockArchiveFetch(status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ server: { id: 'abc', display_name: 'EU Main', slug: 'eu-main' } }),
          { status },
        ),
      ),
    ),
  );
}

async function renderPage() {
  await act(async () => {
    render(
      <Suspense>
        <RestorePage params={Promise.resolve({ id: 'abc' })} />
      </Suspense>,
    );
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('RestorePage', () => {
  it('is a valid React component', () => {
    expect(RestorePage).toBeDefined();
    expect(typeof RestorePage).toBe('function');
  });

  it('форма мастера подписана по-русски и предзаполнена из архива', async () => {
    mockArchiveFetch();
    await renderPage();

    const headings = await screen.findAllByRole('heading', { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent('Восстановление сервера из архива');

    expect(screen.getByLabelText(/^Идентификатор нового сервера/)).toHaveValue('eu-main-restored');
    expect(screen.getByLabelText(/^Отображаемое имя/)).toHaveValue('EU Main (restored)');
    expect(screen.queryByLabelText(/^Slug/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Создать новый сервер из бэкапа' })).toHaveAttribute(
      'type',
      'submit',
    );
    expect(screen.getByRole('link', { name: 'К архиву' })).toHaveAttribute(
      'href',
      '/servers/archive',
    );
  });

  it('недоступная запись архива показывается полосой ошибки, а не формой', async () => {
    mockArchiveFetch(404);
    await renderPage();

    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent('Не удалось получить запись архива');
    expect(screen.queryByRole('button', { name: 'Создать новый сервер из бэкапа' })).toBeNull();
  });
});
