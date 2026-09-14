// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/settings/tokens'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

import TokensPage from './page';

/**
 * jsdom 29 знает элемент `<dialog>`, но не реализует `showModal()`/`close()`,
 * а подтверждение отзыва построено на примитиве `Modal`. Полифилл повторяет
 * ровно то, на что опирается примитив: атрибут `open`, фокус внутрь окна и
 * цепочку Escape → отменяемое `cancel` → `close`.
 */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const escapeHandlers = new WeakMap<HTMLDialogElement, (event: KeyboardEvent) => void>();

if (typeof HTMLDialogElement.prototype.showModal !== 'function') {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const notPrevented = this.dispatchEvent(new Event('cancel', { cancelable: true }));
      if (notPrevented) this.close();
    };
    escapeHandlers.set(this, onKeyDown);
    this.addEventListener('keydown', onKeyDown);
    this.querySelector<HTMLElement>(FOCUSABLE)?.focus();
  };

  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement, value?: string) {
    if (value !== undefined) this.returnValue = value;
    this.removeAttribute('open');
    const onKeyDown = escapeHandlers.get(this);
    if (onKeyDown) {
      this.removeEventListener('keydown', onKeyDown);
      escapeHandlers.delete(this);
    }
    this.dispatchEvent(new Event('close'));
  };
}

const ME = {
  steam_id64: '76561198000000001',
  canonical_name: 'Alpha',
  permissions: ['role:view', 'server:view'],
};

const ACTIVE_TOKEN = {
  id: 'tok-1',
  name: 'CI runner',
  scopes: ['server:view'],
  last_used_at: null,
  created_at: '2026-07-20T00:00:00.000Z',
  revoked_at: null,
};

let tokens: unknown[] = [ACTIVE_TOKEN];
let deleteStatus = 200;

function installFetch() {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'DELETE') {
      return Promise.resolve(new Response('{}', { status: deleteStatus }));
    }
    if (url === '/api/v1/me/tokens' && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: 'tok-new',
            name: body.name,
            scopes: body.scopes,
            last_used_at: null,
            created_at: '2026-07-24T00:00:00.000Z',
            revoked_at: null,
            plaintext: 'sqp_secret_value',
          }),
          { status: 201 },
        ),
      );
    }
    if (url === '/api/v1/me') {
      return Promise.resolve(new Response(JSON.stringify(ME), { status: 200 }));
    }
    if (url === '/api/v1/me/tokens') {
      return Promise.resolve(new Response(JSON.stringify(tokens), { status: 200 }));
    }
    return Promise.resolve(new Response('{}', { status: 200 }));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function renderPage() {
  const fetchMock = installFetch();
  await act(async () => {
    render(<TokensPage />);
  });
  return fetchMock;
}

function deleteCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(
    (call) => ((call[1] as RequestInit | undefined)?.method ?? 'GET') === 'DELETE',
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  tokens = [ACTIVE_TOKEN];
  deleteStatus = 200;
});

describe('TokensPage', () => {
  it('lists the existing tokens with their scopes and status', async () => {
    await renderPage();
    expect(await screen.findByText('CI runner')).toBeInTheDocument();
    expect(screen.getByText('активен')).toBeInTheDocument();
    expect(
      within(screen.getByRole('table', { name: 'API-токены' })).getByText('server:view'),
    ).toBeInTheDocument();
  });

  it('shows an empty state when no token has been issued', async () => {
    tokens = [];
    await renderPage();
    expect(await screen.findByText('Токенов пока нет')).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'API-токены' })).not.toBeInTheDocument();
  });

  it('creates a token with the selected scopes and shows the secret once', async () => {
    tokens = [];
    const fetchMock = await renderPage();
    await screen.findByText('Токенов пока нет');

    fireEvent.change(screen.getByLabelText('Имя'), { target: { value: 'Discord bot' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'role:view' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Создать токен' }));
    });

    const post = fetchMock.mock.calls.find(
      (call) => ((call[1] as RequestInit | undefined)?.method ?? 'GET') === 'POST',
    );
    expect(JSON.parse(String((post?.[1] as RequestInit).body))).toEqual({
      name: 'Discord bot',
      scopes: ['role:view'],
    });
    expect(await screen.findByText('sqp_secret_value')).toBeInTheDocument();
  });

  it('refuses to create a token without a name and does not call the API', async () => {
    const fetchMock = await renderPage();
    await screen.findByText('CI runner');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Создать токен' }));
    });

    expect(await screen.findByText('Укажите имя токена.')).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.filter(
        (call) => ((call[1] as RequestInit | undefined)?.method ?? 'GET') === 'POST',
      ),
    ).toHaveLength(0);
  });

  it('asks for confirmation before revoking a token', async () => {
    const fetchMock = await renderPage();
    await screen.findByText('CI runner');

    fireEvent.click(screen.getByRole('button', { name: 'Отозвать' }));

    const dialog = await screen.findByRole('dialog', { name: 'Отозвать токен' });
    expect(dialog).toHaveTextContent('CI runner');
    expect(deleteCalls(fetchMock)).toHaveLength(0);

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Отозвать токен' }));
    });

    const calls = deleteCalls(fetchMock);
    expect(calls).toHaveLength(1);
    expect(String(calls[0][0])).toBe('/api/v1/me/tokens/tok-1');
    expect(await screen.findByText('отозван')).toBeInTheDocument();
    expect(screen.getByText('Токен отозван.')).toBeInTheDocument();
  });

  it('revokes nothing when the confirmation is dismissed', async () => {
    const fetchMock = await renderPage();
    await screen.findByText('CI runner');

    fireEvent.click(screen.getByRole('button', { name: 'Отозвать' }));
    const dialog = await screen.findByRole('dialog', { name: 'Отозвать токен' });
    await act(async () => {
      fireEvent.click(within(dialog).getAllByRole('button', { name: 'Отмена' })[0]);
    });

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(deleteCalls(fetchMock)).toHaveLength(0);
    expect(screen.getByText('активен')).toBeInTheDocument();
  });

  it('surfaces a failed revoke request', async () => {
    deleteStatus = 500;
    await renderPage();
    await screen.findByText('CI runner');

    fireEvent.click(screen.getByRole('button', { name: 'Отозвать' }));
    const dialog = await screen.findByRole('dialog', { name: 'Отозвать токен' });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Отозвать токен' }));
    });

    expect(await screen.findByText('HTTP 500')).toBeInTheDocument();
  });
});
