// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DiscordTemplatesSection, { colorToHex, hexToColor } from './DiscordTemplatesSection';

const BAN_ROW = {
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
  updated_at: '2026-07-26T12:00:00.000Z',
};

const KICK_ROW = {
  event_type: 'kick',
  locale: 'ru',
  template: {
    title: 'Игрок кикнут',
    url: null,
    description: 'Кик по причине {reason}',
    color: 5793266,
    fields: [],
  },
  is_default: true,
  updated_at: '2026-07-26T12:00:00.000Z',
};

const PREVIEW_RESPONSE = {
  event_type: 'ban_issued',
  embed: {
    title: 'Забанен игрок',
    description: 'Тестовый Игрок получил бан',
    color: 15548997,
    fields: [{ name: 'Кто', value: 'Тестовый Игрок', inline: true }],
    url: null,
  },
  missing_placeholders: [] as string[],
};

interface Routes {
  list?: () => Promise<Response>;
  put?: () => Promise<Response>;
  reset?: () => Promise<Response>;
  preview?: () => Promise<Response>;
}

function mockFetch(routes: Routes = {}) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith('/preview') && init?.method === 'POST') {
      return routes.preview
        ? routes.preview()
        : Promise.resolve(new Response(JSON.stringify(PREVIEW_RESPONSE), { status: 200 }));
    }
    if (url.endsWith('/reset') && init?.method === 'POST') {
      return routes.reset
        ? routes.reset()
        : Promise.resolve(new Response(JSON.stringify(BAN_ROW), { status: 200 }));
    }
    if (url.includes('/api/v1/integrations/discord/templates/') && init?.method === 'PUT') {
      return routes.put
        ? routes.put()
        : Promise.resolve(
            new Response(JSON.stringify({ ...BAN_ROW, is_default: false }), { status: 200 }),
          );
    }
    if (url.endsWith('/api/v1/integrations/discord/templates') && init?.method === undefined) {
      return routes.list
        ? routes.list()
        : Promise.resolve(new Response(JSON.stringify([BAN_ROW, KICK_ROW]), { status: 200 }));
    }
    return Promise.reject(new Error(`unexpected fetch: ${url} ${init?.method}`));
  });
}

function install(routes: Routes = {}) {
  const fetchMock = mockFetch(routes);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

type FetchMock = ReturnType<typeof mockFetch>;
type FetchCall = FetchMock['mock']['calls'][number];

function callsWithMethod(fetchMock: FetchMock, method: string): FetchCall[] {
  return fetchMock.mock.calls.filter((call) => call[1]?.method === method);
}

function parseBody(call: FetchCall): Record<string, unknown> {
  return JSON.parse(String(call[1]?.body)) as Record<string, unknown>;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('DiscordTemplatesSection', () => {
  it('loads the template list and renders the first event type', async () => {
    install();
    render(<DiscordTemplatesSection />);

    expect(await screen.findByText('Шаблоны сообщений')).toBeInTheDocument();
    expect(await screen.findByLabelText('Событие')).toHaveValue('ban_issued');
    expect(screen.getByRole('option', { name: 'Выдан бан' })).toBeInTheDocument();
    expect(screen.getByLabelText('Заголовок')).toHaveValue('Player banned');
    expect(screen.getByLabelText('Описание')).toHaveValue('Игрок {player_name} забанен');
  });

  it('renders nothing when the templates request returns 403', async () => {
    install({
      list: () =>
        Promise.resolve(
          new Response(JSON.stringify({ error: 'forbidden', required: ['integration:manage'] }), {
            status: 403,
          }),
        ),
    });
    const { container } = render(<DiscordTemplatesSection />);

    await waitFor(() => expect(container.firstChild).toBeNull());
    expect(screen.queryByText('Шаблоны сообщений')).not.toBeInTheDocument();
  });

  it('PUTs the full embed object and re-renders from the response', async () => {
    const fetchMock = install();
    const user = userEvent.setup();
    render(<DiscordTemplatesSection />);

    const title = await screen.findByLabelText('Заголовок');
    expect(screen.getByText('дефолтный')).toBeInTheDocument();
    await user.clear(title);
    await user.type(title, 'Бан выдан');
    await user.click(screen.getByRole('button', { name: 'Сохранить шаблон' }));

    await waitFor(() => expect(callsWithMethod(fetchMock, 'PUT')).toHaveLength(1));
    const [call] = callsWithMethod(fetchMock, 'PUT');
    if (!call) throw new Error('no PUT call recorded');
    expect(String(call[0])).toBe('/api/v1/integrations/discord/templates/ban_issued');
    const body = parseBody(call);
    expect(body.locale).toBe('en');
    const template = body.template as Record<string, unknown>;
    expect(template.title).toBe('Бан выдан');
    expect(template.description).toBe('Игрок {player_name} забанен');
    expect(template.color).toBe(15548997);
    expect(template.url).toBe('{player_url}');
    expect(template.fields).toEqual([{ name: 'Player', value: '{player_name}', inline: true }]);

    await waitFor(() => expect(screen.queryByText('дефолтный')).not.toBeInTheDocument());
  });

  it('resets to the default template through the reset route', async () => {
    const fetchMock = install({
      reset: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              ...BAN_ROW,
              template: { ...BAN_ROW.template, title: 'Дефолтный заголовок' },
              is_default: true,
            }),
            { status: 200 },
          ),
        ),
    });
    const user = userEvent.setup();
    render(<DiscordTemplatesSection />);

    await screen.findByLabelText('Заголовок');
    await user.click(screen.getByRole('button', { name: 'Сбросить к дефолту' }));

    await waitFor(() => expect(callsWithMethod(fetchMock, 'POST').length).toBeGreaterThan(0));
    const resetCall = callsWithMethod(fetchMock, 'POST').find((call) =>
      String(call[0]).endsWith('/reset'),
    );
    if (!resetCall) throw new Error('no reset call recorded');
    expect(String(resetCall[0])).toBe('/api/v1/integrations/discord/templates/ban_issued/reset');

    await waitFor(() =>
      expect(screen.getByLabelText('Заголовок')).toHaveValue('Дефолтный заголовок'),
    );
  });

  it('debounced preview renders the embed returned by the API', async () => {
    const fetchMock = install();
    render(<DiscordTemplatesSection />);

    expect(
      await screen.findByText('Забанен игрок', undefined, { timeout: 3000 }),
    ).toBeInTheDocument();
    expect(screen.getByText('Тестовый Игрок получил бан')).toBeInTheDocument();
    expect(screen.getByText('Кто')).toBeInTheDocument();
    expect(screen.getByText('Тестовый Игрок')).toBeInTheDocument();

    const previewCall = callsWithMethod(fetchMock, 'POST').find((call) =>
      String(call[0]).endsWith('/preview'),
    );
    if (!previewCall) throw new Error('no preview call recorded');
    expect(String(previewCall[0])).toBe(
      '/api/v1/integrations/discord/templates/ban_issued/preview',
    );
    const body = parseBody(previewCall);
    expect((body.template as Record<string, unknown>).title).toBe('Player banned');
    const context = body.context as Record<string, string>;
    expect(Object.keys(context)).toHaveLength(11);
    expect(context.player_name).toBe('Тестовый Игрок');
    expect(context.join_link).toBe('steam://connect/127.0.0.1:7787');
  });

  it('warns about placeholders the renderer could not resolve', async () => {
    install({
      preview: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({ ...PREVIEW_RESPONSE, missing_placeholders: ['nope', 'также_нет'] }),
            { status: 200 },
          ),
        ),
    });
    render(<DiscordTemplatesSection />);

    expect(
      await screen.findByText('Неизвестные плейсхолдеры:', undefined, { timeout: 3000 }),
    ).toBeInTheDocument();
    expect(screen.getByText('nope, также_нет')).toBeInTheDocument();
  });

  it('hides the placeholder warning when nothing is missing', async () => {
    install();
    render(<DiscordTemplatesSection />);

    expect(
      await screen.findByText('Забанен игрок', undefined, { timeout: 3000 }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Неизвестные плейсхолдеры:')).not.toBeInTheDocument();
  });

  it('adds and removes an embed field', async () => {
    install();
    const user = userEvent.setup();
    render(<DiscordTemplatesSection />);

    await screen.findByLabelText('Заголовок');
    expect(screen.getAllByRole('button', { name: 'Удалить поле' })).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Добавить поле' }));
    expect(screen.getAllByRole('button', { name: 'Удалить поле' })).toHaveLength(2);

    const removeButtons = screen.getAllByRole('button', { name: 'Удалить поле' });
    const last = removeButtons[removeButtons.length - 1];
    if (!last) throw new Error('no remove button rendered');
    await user.click(last);
    expect(screen.getAllByRole('button', { name: 'Удалить поле' })).toHaveLength(1);
  });

  it('shows the server error when saving fails', async () => {
    install({
      put: () =>
        Promise.resolve(
          new Response(JSON.stringify({ error: 'template_not_found' }), { status: 404 }),
        ),
    });
    const user = userEvent.setup();
    render(<DiscordTemplatesSection />);

    await screen.findByLabelText('Заголовок');
    await user.click(screen.getByRole('button', { name: 'Сохранить шаблон' }));

    expect(await screen.findByText(/template_not_found/)).toBeInTheDocument();
    expect(screen.getByText('Шаблоны сообщений')).toBeInTheDocument();
  });

  it('switching the event select loads the other template into the form', async () => {
    install();
    const user = userEvent.setup();
    render(<DiscordTemplatesSection />);

    await screen.findByLabelText('Заголовок');
    await user.selectOptions(screen.getByLabelText('Событие'), 'kick');

    expect(screen.getByLabelText('Заголовок')).toHaveValue('Игрок кикнут');
    expect(screen.getByLabelText('Ссылка (URL)')).toHaveValue('');
    expect(screen.getByLabelText('Локаль')).toHaveValue('ru');
  });

  it('colorToHex pads a colour to six hex digits', () => {
    expect(colorToHex(0x5865f2)).toBe('#5865f2');
    expect(colorToHex(0)).toBe('#000000');
  });

  it('hexToColor parses #rrggbb and rejects everything else', () => {
    expect(hexToColor('#5865F2')).toBe(5793266);
    expect(hexToColor('  #000000 ')).toBe(0);
    expect(hexToColor('5865f2')).toBeNull();
    expect(hexToColor('')).toBeNull();
  });
});
