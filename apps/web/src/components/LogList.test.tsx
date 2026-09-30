// @vitest-environment happy-dom
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
    render(<LogList servers={SERVERS} canExport={true} />);

    expect(await screen.findByRole('columnheader', { name: 'Сообщение' })).toBeInTheDocument();
    for (const name of ['Время', 'Уровень', 'Источник', 'Сервер']) {
      expect(screen.getByRole('columnheader', { name })).toBeInTheDocument();
    }
    expect(screen.getByText('соединение с мостом потеряно')).toBeInTheDocument();
    expect(screen.getByText('запрос обработан')).toBeInTheDocument();
  });

  it('names the level in text, so the row does not rely on colour alone', async () => {
    stubFetch();
    render(<LogList servers={SERVERS} canExport={true} />);

    await screen.findByText('запрос обработан');
    expect(screen.getByText('error')).toBeInTheDocument();
    expect(screen.getByText('info')).toBeInTheDocument();
  });

  it('offers a disclosure only for entries that carry a context', async () => {
    stubFetch();
    render(<LogList servers={SERVERS} canExport={true} />);

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
    render(<LogList servers={SERVERS} canExport={true} />);
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
    render(<LogList servers={SERVERS} canExport={true} />);

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
    render(<LogList servers={SERVERS} canExport={true} />);
    await screen.findByText('запрос обработан');

    fireEvent.click(screen.getByRole('checkbox', { name: 'rcon' }));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('src='))).toBe(true),
    );
  });

  // #781: config-sync is a real source; it must be listed and survive a narrowed filter.
  it('offers config-sync as a source and keeps it in a narrowed filter', async () => {
    const fetchMock = stubFetch();
    render(<LogList servers={SERVERS} canExport={true} />);
    await screen.findByText('запрос обработан');

    expect(screen.getByRole('checkbox', { name: 'config-sync' })).toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: 'rcon' }));

    await waitFor(() => {
      const narrowed = fetchMock.mock.calls
        .map(([url]) => new URL(String(url), 'http://x').searchParams.get('src'))
        .find((src) => src !== null);
      expect(narrowed?.split(',')).toContain('C');
      expect(narrowed?.split(',')).not.toContain('R');
    });
  });

  // #778: an empty first page (fresh stream, or a filter matching none of the
  // recent entries) used to leave no cursor, so polling never started.
  it('keeps tailing after an empty first response', async () => {
    const fetchMock = vi.fn((_url: string) =>
      Promise.resolve(new Response(JSON.stringify({ entries: [], newest_scanned_id: '0-0' }))),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<LogList servers={SERVERS} canExport={true} />);

    await waitFor(
      () =>
        expect(fetchMock.mock.calls.some(([url]) => String(url).includes('after=0-0'))).toBe(true),
      { timeout: 3000 },
    );
  });

  // Regression (#186): the live tail advanced only past matching entries, so a
  // run of filtered-out entries was re-read forever and later matches never came.
  it('advances the live-tail cursor to the newest scanned id even when nothing matched', async () => {
    const fetchMock = vi.fn((url: string) => {
      const body = url.includes('after=')
        ? { entries: [], newest_scanned_id: '200-0' }
        : { entries: [], newest_scanned_id: '100-0' };
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<LogList servers={SERVERS} canExport={true} />);

    await waitFor(
      () => {
        const urls = fetchMock.mock.calls.map(([url]) => url);
        expect(urls.some((u) => u.includes('after=100-0'))).toBe(true);
        expect(urls.some((u) => u.includes('after=200-0'))).toBe(true);
      },
      { timeout: 4000 },
    );
  });

  it('hides the export link without the host:metrics permission', async () => {
    stubFetch();
    render(<LogList servers={SERVERS} canExport={false} />);
    await screen.findByText('запрос обработан');

    expect(screen.queryByRole('link', { name: 'Экспорт' })).not.toBeInTheDocument();
  });

  it('shows a retryable error instead of an endless skeleton when the first load fails', async () => {
    let failing = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          failing
            ? new Response('{}', { status: 500 })
            : new Response(JSON.stringify({ entries: ENTRIES }), { status: 200 }),
        ),
      ),
    );
    render(<LogList servers={SERVERS} canExport={true} />);

    expect(await screen.findByText('Не удалось загрузить записи')).toBeInTheDocument();
    failing = false;
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));

    expect(await screen.findByText('запрос обработан')).toBeInTheDocument();
  });

  it('renders the entry time in the local zone, not as UTC ISO text', async () => {
    stubFetch();
    render(<LogList servers={SERVERS} canExport={true} />);
    await screen.findByText('запрос обработан');

    const expected = new Date(ENTRIES[0]?.ts as number).toLocaleTimeString('ru-RU', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      fractionalSecondDigits: 3,
    });
    expect(screen.getByText(expected)).toBeInTheDocument();
  });
});
