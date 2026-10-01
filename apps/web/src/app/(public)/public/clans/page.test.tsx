// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/forwarded-client', () => ({
  forwardedClientHeaders: vi.fn().mockResolvedValue({ 'x-forwarded-for': '203.0.113.9' }),
}));

import PublicClansPage, { dynamic, metadata } from './page';

const CLANS = {
  total: 2,
  items: [
    { id: 'clan-1', name: 'Альфа', tags: ['ALF', 'A1'], description: 'Играем по вечерам' },
    { id: 'clan-2', name: 'Бета', tags: ['BET'], description: null },
  ],
};

function stubFetch(response: Response) {
  const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
    Promise.resolve(response),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('PublicClansPage', () => {
  it('lists every public clan as a card linking to its page', async () => {
    stubFetch(new Response(JSON.stringify(CLANS)));
    render(await PublicClansPage());

    expect(screen.getByRole('heading', { level: 1, name: 'Публичные кланы' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Альфа/ })).toHaveAttribute(
      'href',
      '/public/clans/clan-1',
    );
    expect(screen.getByRole('link', { name: /Бета/ })).toHaveAttribute(
      'href',
      '/public/clans/clan-2',
    );
    expect(screen.getByText('Всего: 2')).toBeInTheDocument();
  });

  it('shows tags joined together and the description only when there is one', async () => {
    stubFetch(new Response(JSON.stringify(CLANS)));
    render(await PublicClansPage());

    expect(screen.getByText('ALF · A1')).toBeInTheDocument();
    expect(screen.getByText('Играем по вечерам')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Бета/ })).not.toHaveTextContent('null');
  });

  it('shows the empty state when no clan has opened its page', async () => {
    stubFetch(new Response(JSON.stringify({ items: [], total: 0 })));
    render(await PublicClansPage());

    expect(screen.getByText('Публичных кланов пока нет.')).toBeInTheDocument();
    expect(screen.queryByText(/Всего:/)).not.toBeInTheDocument();
  });

  it('requests the anonymous directory and relays the visitor address', async () => {
    const fetchMock = stubFetch(new Response(JSON.stringify(CLANS)));
    await PublicClansPage();

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('/api/v1/public/clans');
    expect(new Headers(init?.headers).get('x-forwarded-for')).toBe('203.0.113.9');
  });

  it('lets an API failure reach the error boundary', async () => {
    stubFetch(new Response('{}', { status: 429 }));

    await expect(PublicClansPage()).rejects.toMatchObject({ status: 429 });
  });

  it('is rendered per request and titled for the public directory', () => {
    expect(dynamic).toBe('force-dynamic');
    expect(metadata.title).toBe('Публичные кланы — Squad Admin Panel');
  });
});
