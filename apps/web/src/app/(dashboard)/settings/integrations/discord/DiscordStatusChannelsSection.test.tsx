// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DiscordStatusChannelsSection, { statusChannelPreview } from './DiscordStatusChannelsSection';

const ITEMS = [
  {
    server_id: 'srv-1',
    display_name: 'Main #1',
    slug: 'main-1',
    channel_id: '600000000000000101',
  },
  { server_id: 'srv-2', display_name: 'Main #2', slug: 'main-2', channel_id: null },
];

interface Routes {
  list?: () => Promise<Response>;
  save?: (body: unknown) => Promise<Response>;
}

function mockFetch(routes: Routes = {}) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.includes('/status-channel') && init?.method === 'PUT') {
      return routes.save
        ? routes.save(body)
        : Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    }
    if (url.endsWith('/api/v1/integrations/discord/status-channels')) {
      return routes.list
        ? routes.list()
        : Promise.resolve(new Response(JSON.stringify({ items: ITEMS }), { status: 200 }));
    }
    return Promise.reject(new Error(`unexpected fetch: ${url} ${init?.method}`));
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('statusChannelPreview', () => {
  it('shows the template a configured channel will be renamed to', () => {
    expect(statusChannelPreview('600000000000000101')).toContain('_');
  });

  it('returns null when no channel is configured', () => {
    expect(statusChannelPreview(null)).toBeNull();
  });
});

describe('DiscordStatusChannelsSection', () => {
  it('lists every server with its configured status channel', async () => {
    vi.stubGlobal('fetch', mockFetch());
    render(<DiscordStatusChannelsSection />);

    expect(await screen.findByText('Main #1')).toBeInTheDocument();
    expect(screen.getByText('Main #2')).toBeInTheDocument();
    expect(screen.getByDisplayValue('600000000000000101')).toBeInTheDocument();
  });

  it('renders nothing when the API answers 403 (self-hide-on-403 gating)', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        list: () =>
          Promise.resolve(new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 })),
      }),
    );
    const { container } = render(<DiscordStatusChannelsSection />);

    await waitFor(() => expect(container.querySelector('section')).toBeNull());
  });

  it('saves an edited channel id through the PUT route', async () => {
    const save = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })),
    );
    vi.stubGlobal('fetch', mockFetch({ save }));
    render(<DiscordStatusChannelsSection />);

    const input = await screen.findByLabelText('ID статус-канала для Main #2');
    await userEvent.type(input, '600000000000000202');
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить статус-канал Main #2' }));

    await waitFor(() => expect(save).toHaveBeenCalledWith({ channel_id: '600000000000000202' }));
  });

  it('clears the channel when the field is emptied', async () => {
    const save = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })),
    );
    vi.stubGlobal('fetch', mockFetch({ save }));
    render(<DiscordStatusChannelsSection />);

    const input = await screen.findByLabelText('ID статус-канала для Main #1');
    await userEvent.clear(input);
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить статус-канал Main #1' }));

    await waitFor(() => expect(save).toHaveBeenCalledWith({ channel_id: null }));
  });

  it('surfaces a save failure to the operator', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        save: () =>
          Promise.resolve(
            new Response(JSON.stringify({ error: 'server_not_found' }), { status: 404 }),
          ),
      }),
    );
    render(<DiscordStatusChannelsSection />);

    const input = await screen.findByLabelText('ID статус-канала для Main #2');
    await userEvent.type(input, '600000000000000202');
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить статус-канал Main #2' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/не удалось/i);
  });
});
