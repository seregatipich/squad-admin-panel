// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReportPlayerSection } from './ReportPlayerSection';

const TEST_TIMEOUT_MS = 15_000;

const SERVERS = {
  items: [
    { id: 'srv-1', display_name: 'EU Server 1', slug: 'eu-1' },
    { id: 'srv-2', display_name: 'EU Server 2', slug: 'eu-2' },
  ],
};

type Handler = (url: string, init?: RequestInit) => Response | undefined;

/** Routes `/api/v1/servers` (status configurable) plus any per-test handler. */
function mockFetch(serversStatus = 200, handler: Handler = () => undefined) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const handled = handler(url, init);
    if (handled) return Promise.resolve(handled);
    if (url.endsWith('/api/v1/servers')) {
      if (serversStatus !== 200) {
        return Promise.resolve(new Response(null, { status: serversStatus }));
      }
      return Promise.resolve(new Response(JSON.stringify(SERVERS), { status: 200 }));
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

async function openModal() {
  fireEvent.click(screen.getByRole('button', { name: /пожаловаться/i }));
  await screen.findByRole('option', { name: 'EU Server 1' });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ReportPlayerSection', () => {
  it(
    'renders nothing for a viewer without server:view',
    () => {
      const fetchMock = mockFetch();
      vi.stubGlobal('fetch', fetchMock);
      const { container } = render(
        <ReportPlayerSection playerId="player-1" canViewServers={false} />,
      );
      expect(container).toBeEmptyDOMElement();
      expect(fetchMock).not.toHaveBeenCalled();
    },
    TEST_TIMEOUT_MS,
  );

  // Regression (#465): the server list (three Redis reads per server) was
  // fetched on every card open, although only the modal needs it.
  it(
    'loads the server list only when the modal opens',
    async () => {
      const fetchMock = mockFetch();
      vi.stubGlobal('fetch', fetchMock);
      render(<ReportPlayerSection playerId="player-1" canViewServers />);

      expect(screen.getByRole('button', { name: /пожаловаться/i })).toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalled();

      await openModal();
      expect(screen.getByLabelText(/^сервер$/i)).toBeInTheDocument();
      expect(screen.getByText(/текст жалобы/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /отправить жалобу/i })).toBeDisabled();
    },
    TEST_TIMEOUT_MS,
  );

  // Regression (#465): any failure used to hide the button for good.
  it(
    'keeps the button and offers a retry in the modal when the server list fails',
    async () => {
      let failing = true;
      vi.stubGlobal(
        'fetch',
        mockFetch(200, (url) =>
          url.endsWith('/api/v1/servers') && failing ? json({}, 500) : undefined,
        ),
      );
      render(<ReportPlayerSection playerId="player-1" canViewServers />);

      fireEvent.click(screen.getByRole('button', { name: /пожаловаться/i }));
      expect(await screen.findByText('Не удалось загрузить список серверов')).toBeInTheDocument();

      failing = false;
      fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
      expect(await screen.findByRole('option', { name: 'EU Server 1' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /пожаловаться/i })).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  // Regression (#466): the raw `server_not_found` code reached the banner.
  it(
    'translates a report rejection into Russian',
    async () => {
      vi.stubGlobal(
        'fetch',
        mockFetch(200, (url) =>
          url.endsWith('/api/v1/reports') ? json({ error: 'server_not_found' }, 400) : undefined,
        ),
      );
      render(<ReportPlayerSection playerId="player-1" canViewServers />);
      await openModal();

      fireEvent.change(screen.getByLabelText(/^сервер$/i), { target: { value: 'srv-1' } });
      fireEvent.change(screen.getByPlaceholderText('Опишите нарушение…'), {
        target: { value: 'Тимкилл' },
      });
      fireEvent.click(screen.getByRole('button', { name: /отправить жалобу/i }));

      expect(
        await screen.findByText('Сервер не найден — обновите список и выберите снова.'),
      ).toBeInTheDocument();
      expect(screen.queryByText('server_not_found')).not.toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  // Regression (#464): removed attachments stayed in the media library.
  it(
    'deletes an uploaded attachment from the media library when it is removed',
    async () => {
      const fetchMock = mockFetch(200, (url, init) => {
        if (url.endsWith('/api/v1/media/link')) {
          return json(
            { id: 'media-1', original_filename: 'x', external_url: 'https://e.x/1', title: null },
            201,
          );
        }
        if (url.endsWith('/api/v1/media/media-1') && init?.method === 'DELETE')
          return json({ ok: true });
        return undefined;
      });
      vi.stubGlobal('fetch', fetchMock);
      render(<ReportPlayerSection playerId="player-1" canViewServers />);
      await openModal();

      fireEvent.change(screen.getByLabelText('Ссылка на доказательство'), {
        target: { value: 'https://e.x/1' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Добавить' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Убрать вложение https://e.x/1' }));

      await waitFor(() =>
        expect(
          fetchMock.mock.calls.some(
            ([url, init]) =>
              String(url).endsWith('/api/v1/media/media-1') && init?.method === 'DELETE',
          ),
        ).toBe(true),
      );
      expect(screen.queryByText('https://e.x/1')).not.toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'deletes every uploaded attachment when the modal is cancelled',
    async () => {
      const fetchMock = mockFetch(200, (url, init) => {
        if (url.endsWith('/api/v1/media/link')) {
          return json(
            { id: 'media-2', original_filename: 'x', external_url: 'https://e.x/2', title: null },
            201,
          );
        }
        if (url.endsWith('/api/v1/media/media-2') && init?.method === 'DELETE')
          return json({ ok: true });
        return undefined;
      });
      vi.stubGlobal('fetch', fetchMock);
      render(<ReportPlayerSection playerId="player-1" canViewServers />);
      await openModal();

      fireEvent.change(screen.getByLabelText('Ссылка на доказательство'), {
        target: { value: 'https://e.x/2' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Добавить' }));
      await screen.findByText('https://e.x/2');
      fireEvent.click(screen.getByRole('button', { name: 'Отмена' }));

      await waitFor(() =>
        expect(
          fetchMock.mock.calls.some(
            ([url, init]) =>
              String(url).endsWith('/api/v1/media/media-2') && init?.method === 'DELETE',
          ),
        ).toBe(true),
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'keeps the attachments of a report that was sent',
    async () => {
      const fetchMock = mockFetch(200, (url) => {
        if (url.endsWith('/api/v1/media/link')) {
          return json(
            { id: 'media-3', original_filename: 'x', external_url: 'https://e.x/3', title: null },
            201,
          );
        }
        if (url.endsWith('/api/v1/reports')) return json({ id: 'report-1' }, 201);
        return undefined;
      });
      vi.stubGlobal('fetch', fetchMock);
      render(<ReportPlayerSection playerId="player-1" canViewServers />);
      await openModal();

      fireEvent.change(screen.getByLabelText(/^сервер$/i), { target: { value: 'srv-1' } });
      fireEvent.change(screen.getByPlaceholderText('Опишите нарушение…'), {
        target: { value: 'Тимкилл' },
      });
      fireEvent.change(screen.getByLabelText('Ссылка на доказательство'), {
        target: { value: 'https://e.x/3' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Добавить' }));
      await screen.findByText('https://e.x/3');
      fireEvent.click(screen.getByRole('button', { name: /отправить жалобу/i }));

      expect(await screen.findByText('Жалоба отправлена')).toBeInTheDocument();
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );
});
