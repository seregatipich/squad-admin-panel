// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

let mockSearchParams = new URLSearchParams();
const replaceMock = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({ replace: replaceMock })),
  usePathname: vi.fn(() => '/events'),
  useSearchParams: vi.fn(() => mockSearchParams),
}));

import { EventsBrowser } from './EventsBrowser';

function mockFetch() {
  return vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith('/api/v1/events/count')) {
      return Promise.resolve(new Response(JSON.stringify({ total: 0 }), { status: 200 }));
    }
    if (url.startsWith('/api/v1/events')) {
      return Promise.resolve(
        new Response(JSON.stringify({ items: [], next_cursor: null, limit: 50 }), {
          status: 200,
        }),
      );
    }
    if (url.startsWith('/api/v1/servers')) {
      return Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }));
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  replaceMock.mockClear();
  mockSearchParams = new URLSearchParams();
});

describe('EventsBrowser — BANNAME-3 rule filter chip', () => {
  it('shows no rule chip without a ?rule param', async () => {
    vi.stubGlobal('fetch', mockFetch());
    render(<EventsBrowser />);
    await screen.findByRole('link', { name: 'Экспорт CSV' });
    expect(screen.queryByText(/правило:/i)).not.toBeInTheDocument();
  });

  it('shows a removable «Правило: …» chip when ?rule is set, and clears it on click', async () => {
    mockSearchParams = new URLSearchParams('rule=22222222-2222-2222-2222-222222222222');
    vi.stubGlobal('fetch', mockFetch());
    render(<EventsBrowser />);
    const chip = await screen.findByText(/правило: 22222222/i);
    expect(chip).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /убрать фильтр по правилу/i }));
    expect(replaceMock).toHaveBeenCalledWith(expect.not.stringContaining('rule='));
  });

  it('sends ruleId on the events list/count requests when ?rule is set', async () => {
    mockSearchParams = new URLSearchParams('rule=rule-abc');
    const fetchMock = mockFetch();
    vi.stubGlobal('fetch', fetchMock);
    render(<EventsBrowser />);
    await screen.findByRole('link', { name: 'Экспорт CSV' });
    const calledUrls = fetchMock.mock.calls.map(([input]) =>
      typeof input === 'string' ? input : String(input),
    );
    expect(calledUrls.some((url) => url.includes('ruleId=rule-abc'))).toBe(true);
  });
});

describe('EventsBrowser — заголовки', () => {
  it('не рендерит собственный <h1>: на верхнем уровне его даёт страница', async () => {
    vi.stubGlobal('fetch', mockFetch());
    render(<EventsBrowser />);
    await screen.findByRole('link', { name: 'Экспорт CSV' });
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
  });

  it('во вложенном режиме сервера даёт только заголовок раздела', async () => {
    vi.stubGlobal('fetch', mockFetch());
    render(<EventsBrowser lockedServerId="srv-1" />);
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Журнал событий' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
  });
});
