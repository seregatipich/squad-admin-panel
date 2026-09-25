// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/settings/integrations/discord'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

import {
  DISCORD_EVENT_TYPES,
  describeTestSendOutcome,
  eventLabel,
  looksLikeWebhookUrl,
} from './discord-events';
import DiscordIntegrationPage from './page';

describe('DiscordIntegrationPage', () => {
  it('is a valid React component', () => {
    expect(DiscordIntegrationPage).toBeDefined();
    expect(typeof DiscordIntegrationPage).toBe('function');
  });

  it('exposes the fixed event types', () => {
    expect(DISCORD_EVENT_TYPES).toHaveLength(13);
    expect(DISCORD_EVENT_TYPES).toContain('server_crashed');
    expect(DISCORD_EVENT_TYPES).toContain('server_monitoring');
    expect(DISCORD_EVENT_TYPES).toContain('seed_needed');
  });

  it('maps event types to Russian labels and falls back to the raw key', () => {
    expect(eventLabel('ban_issued')).toBe('Выдан бан');
    expect(eventLabel('unknown_event')).toBe('unknown_event');
  });

  it('accepts real discord webhook urls and rejects everything else', () => {
    expect(
      looksLikeWebhookUrl('https://discord.com/api/webhooks/123456789012345678/abcDEF_-.123'),
    ).toBe(true);
    expect(
      looksLikeWebhookUrl('https://discordapp.com/api/v10/webhooks/12345/tok_en-value.1'),
    ).toBe(true);
    expect(looksLikeWebhookUrl('https://evil.example/api/webhooks/1/2')).toBe(false);
    expect(looksLikeWebhookUrl('not a url')).toBe(false);
    expect(looksLikeWebhookUrl('')).toBe(false);
  });
});

describe('describeTestSendOutcome', () => {
  it('returns "Отправлено" for a 2xx response', () => {
    expect(describeTestSendOutcome(true, {})).toEqual({ kind: 'ok', text: 'Отправлено' });
  });

  it('surfaces the upstream Discord status', () => {
    expect(describeTestSendOutcome(false, { error: 'discord_error', status: 500 })).toEqual({
      kind: 'err',
      text: 'Discord вернул 500',
    });
  });

  it('surfaces an unreachable webhook', () => {
    expect(describeTestSendOutcome(false, { error: 'unreachable' })).toEqual({
      kind: 'err',
      text: 'Вебхук недоступен',
    });
  });

  it('surfaces webhook_not_found', () => {
    expect(describeTestSendOutcome(false, { error: 'webhook_not_found' })).toEqual({
      kind: 'err',
      text: 'Вебхук не найден',
    });
  });

  it('falls back to a generic message for an unrecognized error', () => {
    expect(describeTestSendOutcome(false, {})).toEqual({
      kind: 'err',
      text: 'Не удалось отправить тестовое сообщение',
    });
  });
});

const INTEGRATION_SETTINGS = {
  guild_id: null,
  enabled: false,
  bot_token_configured: false,
  bot_token_mask: null,
  updated_at: null,
};

const WEBHOOK_ROW = {
  id: 'wh-1',
  event_type: 'ban_issued',
  channel_label: '#bans',
  enabled: true,
  mention_everyone: false,
  server_id: null,
  url_configured: true,
  url_mask: '…/1122…/****',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

const TEMPLATE_ROW = {
  event_type: 'ban_issued',
  locale: 'en',
  template: {
    title: 'Player banned',
    url: '{player_url}',
    description: 'Игрок {player_name} забанен',
    color: 15548997,
    fields: [{ name: 'Player', value: '{player_name}', inline: true }],
  },
  is_default: true,
  updated_at: '2026-01-01T00:00:00.000Z',
};

const PREVIEW_RESPONSE = {
  event_type: 'ban_issued',
  embed: {
    title: 'Забанен игрок',
    description: 'Тестовый Игрок забанен',
    color: 15548997,
    fields: [{ name: 'Player', value: 'Тестовый Игрок', inline: true }],
    url: null,
  },
  missing_placeholders: [] as string[],
};

function mockFetch(
  overrides: { test?: () => Promise<Response>; onDelete?: (url: string) => Promise<Response> } = {},
) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith('/api/v1/integrations/discord') && init?.method === undefined) {
      return Promise.resolve(new Response(JSON.stringify(INTEGRATION_SETTINGS), { status: 200 }));
    }
    if (url.endsWith('/api/v1/integrations/discord/webhooks') && init?.method === undefined) {
      return Promise.resolve(new Response(JSON.stringify([WEBHOOK_ROW]), { status: 200 }));
    }
    if (url.includes('/api/v1/integrations/discord/webhooks/') && init?.method === 'DELETE') {
      return overrides.onDelete
        ? overrides.onDelete(url)
        : Promise.resolve(new Response(null, { status: 204 }));
    }
    if (url.endsWith('/test') && init?.method === 'POST') {
      return overrides.test
        ? overrides.test()
        : Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    }
    if (url.endsWith('/api/v1/integrations/discord/templates') && init?.method === undefined) {
      return Promise.resolve(new Response(JSON.stringify([TEMPLATE_ROW]), { status: 200 }));
    }
    if (url.endsWith('/preview') && init?.method === 'POST') {
      return Promise.resolve(new Response(JSON.stringify(PREVIEW_RESPONSE), { status: 200 }));
    }
    // DISCORD-5 (#152): the role-mappings section mounted by the page loads its
    // own data; without these branches every page test would reject here.
    if (url.endsWith('/api/v1/integrations/discord/role-mappings') && init?.method === undefined) {
      return Promise.resolve(
        new Response(JSON.stringify({ items: [], status: null }), { status: 200 }),
      );
    }
    // DISCORD-6 (#153): the page now mounts DiscordStatusChannelsSection, which
    // fetches on mount. This router rejects anything unstubbed, so it needs the route.
    if (
      url.endsWith('/api/v1/integrations/discord/status-channels') &&
      init?.method === undefined
    ) {
      return Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }));
    }
    if (url.endsWith('/api/v1/roles') && init?.method === undefined) {
      return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
    }
    return Promise.reject(new Error(`unexpected fetch: ${url} ${init?.method}`));
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Тест button', () => {
  it('renders one per webhook row and shows success after a 2xx response', async () => {
    vi.stubGlobal('fetch', mockFetch());
    render(<DiscordIntegrationPage />);

    const button = await screen.findByRole('button', { name: 'Тест' });
    fireEvent.click(button);

    await waitFor(() => expect(screen.getByText('Отправлено')).toBeInTheDocument());
  });

  it('shows the specific discord_error message on a 502', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        test: () =>
          Promise.resolve(
            new Response(JSON.stringify({ error: 'discord_error', status: 500 }), {
              status: 502,
            }),
          ),
      }),
    );
    render(<DiscordIntegrationPage />);

    const button = await screen.findByRole('button', { name: 'Тест' });
    fireEvent.click(button);

    await waitFor(() => expect(screen.getByText('Discord вернул 500')).toBeInTheDocument());
  });

  it('shows the unreachable message when the webhook cannot be reached', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        test: () =>
          Promise.resolve(new Response(JSON.stringify({ error: 'unreachable' }), { status: 502 })),
      }),
    );
    render(<DiscordIntegrationPage />);

    const button = await screen.findByRole('button', { name: 'Тест' });
    fireEvent.click(button);

    await waitFor(() => expect(screen.getByText('Вебхук недоступен')).toBeInTheDocument());
  });
});

describe('Шаблоны сообщений', () => {
  it('mounts the message-templates section', async () => {
    vi.stubGlobal('fetch', mockFetch());
    render(<DiscordIntegrationPage />);

    expect(await screen.findByText('Шаблоны сообщений')).toBeInTheDocument();
    expect(await screen.findByLabelText('Заголовок')).toHaveValue('Player banned');
  });
});

describe('Синхронизация ролей', () => {
  it('mounts the role-mappings section', async () => {
    vi.stubGlobal('fetch', mockFetch());
    render(<DiscordIntegrationPage />);

    expect(await screen.findByText('Синхронизация ролей')).toBeInTheDocument();
    expect(await screen.findByText('Маппингов пока нет')).toBeInTheDocument();
  });
});

describe('удаление вебхука', () => {
  it('keeps the webhook when the confirmation dialog is dismissed', async () => {
    const deleted: string[] = [];
    vi.stubGlobal(
      'fetch',
      mockFetch({
        onDelete: (url) => {
          deleted.push(url);
          return Promise.resolve(new Response(null, { status: 204 }));
        },
      }),
    );
    render(<DiscordIntegrationPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Удалить вебхук «Выдан бан»' }));
    const dialog = await screen.findByRole('dialog', { name: 'Удалить вебхук' });
    // «Отмена» носят и крестик окна, и кнопка подвала — нужна вторая.
    const cancels = within(dialog).getAllByRole('button', { name: 'Отмена' });
    fireEvent.click(cancels[cancels.length - 1] as HTMLElement);

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(deleted).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Удалить вебхук «Выдан бан»' })).toBeInTheDocument();
  });

  it('deletes the webhook only after the dialog is confirmed', async () => {
    const deleted: string[] = [];
    vi.stubGlobal(
      'fetch',
      mockFetch({
        onDelete: (url) => {
          deleted.push(url);
          return Promise.resolve(new Response(null, { status: 204 }));
        },
      }),
    );
    render(<DiscordIntegrationPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Удалить вебхук «Выдан бан»' }));
    const dialog = await screen.findByRole('dialog', { name: 'Удалить вебхук' });
    expect(dialog).toHaveTextContent('#bans');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Удалить вебхук' }));

    await waitFor(() => expect(deleted).toHaveLength(1));
    expect(deleted[0]).toContain('/api/v1/integrations/discord/webhooks/wh-1');
    expect(await screen.findByText('Вебхук удалён.')).toBeInTheDocument();
  });
});
