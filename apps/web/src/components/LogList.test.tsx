// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LogList } from './LogList';

const SERVERS = [{ id: 'srv-1', display_name: 'Сервер 1' }];

const ENTRIES = [
  {
    id: 'e1',
    ts: Date.parse('2026-07-23T10:00:00.000Z'),
    source: 'bridge',
    level: 'error',
    serverId: 'aaaaaaaa-bbbb-cccc',
    msg: 'соединение с мостом потеряно',
    ctx: { attempt: 3 },
  },
  {
    id: 'e2',
    ts: Date.parse('2026-07-23T10:00:01.000Z'),
    source: 'api',
    level: 'info',
    msg: 'запрос обработан',
  },
];

/**
 * Отвечает записями на первую выдачу и пустотой на дозагрузку (`after=`),
 * иначе секундный опрос дублировал бы строки прямо во время проверки.
 * Запрос с непустым `q` отвечает пустотой — так проверяется выдача под фильтром.
 */
function stubFetch() {
  const fetchMock = vi.fn((url: string) => {
    const empty = url.includes('after=') || /[?&]q=[^&]+/.test(url);
    return Promise.resolve(
      new Response(JSON.stringify({ entries: empty ? [] : ENTRIES }), { status: 200 }),
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('LogList', () => {
  it('renders the entries as a table with Russian column headers', async () => {
    stubFetch();
    render(<LogList servers={SERVERS} />);

    expect(await screen.findByRole('columnheader', { name: 'Сообщение' })).toBeInTheDocument();
    for (const name of ['Время', 'Уровень', 'Источник', 'Сервер']) {
      expect(screen.getByRole('columnheader', { name })).toBeInTheDocument();
    }
    expect(screen.getByText('соединение с мостом потеряно')).toBeInTheDocument();
    expect(screen.getByText('запрос обработан')).toBeInTheDocument();
  });

  it('names the level in text, so the row does not rely on colour alone', async () => {
    stubFetch();
    render(<LogList servers={SERVERS} />);

    await screen.findByText('запрос обработан');
    expect(screen.getByText('error')).toBeInTheDocument();
    expect(screen.getByText('info')).toBeInTheDocument();
  });

  it('offers a disclosure only for entries that carry a context', async () => {
    stubFetch();
    render(<LogList servers={SERVERS} />);

    const disclosure = await screen.findByRole('button', { name: 'соединение с мостом потеряно' });
    expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: 'запрос обработан' })).not.toBeInTheDocument();

    fireEvent.click(disclosure);
    await waitFor(() => expect(disclosure).toHaveAttribute('aria-expanded', 'true'));
    expect(document.body.textContent).toContain('"attempt": 3');

    fireEvent.click(disclosure);
    await waitFor(() => expect(disclosure).toHaveAttribute('aria-expanded', 'false'));
  });

  it('separates «nothing found» under a filter from «nothing recorded yet»', async () => {
    stubFetch();
    render(<LogList servers={SERVERS} />);
    await screen.findByText('запрос обработан');

    fireEvent.change(screen.getByRole('searchbox', { name: 'Поиск по записям' }), {
      target: { value: 'ничего такого' },
    });

    // Поле поиска отправляет запрос по паузе в наборе.
    const empty = await screen.findByText('Ничего не нашлось');
    expect(empty).toBeInTheDocument();
    expect(screen.queryByText('Записей нет')).not.toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('button', { name: 'Сбросить фильтры' })[0] as HTMLElement);
    await waitFor(() => expect(screen.getByText('запрос обработан')).toBeInTheDocument());
  });

  it('announces the paused state on the pause button', async () => {
    stubFetch();
    render(<LogList servers={SERVERS} />);

    const pause = await screen.findByRole('button', { name: 'Пауза' });
    expect(pause).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(pause);
    expect(await screen.findByRole('button', { name: 'Возобновить' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('keeps the source filter in the request', async () => {
    const fetchMock = stubFetch();
    render(<LogList servers={SERVERS} />);
    await screen.findByText('запрос обработан');

    fireEvent.click(screen.getByRole('checkbox', { name: 'rcon' }));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('src='))).toBe(true),
    );
  });
});
