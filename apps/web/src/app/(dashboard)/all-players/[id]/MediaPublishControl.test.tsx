// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MediaPublishControl } from './MediaPublishControl';
import type { MediaPublication } from './media-publications';

const TEST_TIMEOUT_MS = 15_000;

function publication(overrides: Partial<MediaPublication> = {}): MediaPublication {
  return {
    id: 'pub-1',
    media_id: 'media-1',
    destination: 'telegram',
    status: 'queued',
    external_id: null,
    external_url: null,
    error: null,
    attempts: 0,
    next_attempt_at: null,
    ...overrides,
  };
}

/** Stubs the list GET; subsequent calls (the publish POST) reuse the same handler. */
function stubFetch(status: number, body?: unknown) {
  const impl = vi.fn(() =>
    Promise.resolve(new Response(body !== undefined ? JSON.stringify(body) : null, { status })),
  );
  vi.stubGlobal('fetch', impl);
  return impl;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('MediaPublishControl — permission gating', () => {
  it(
    'renders nothing when the publications endpoint answers 403',
    async () => {
      stubFetch(403);
      const { container } = render(<MediaPublishControl mediaId="media-1" mediaKind="video" />);

      await vi.waitFor(() => expect(container).toBeEmptyDOMElement());
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'renders nothing when the publications endpoint answers 401',
    async () => {
      stubFetch(401);
      const { container } = render(<MediaPublishControl mediaId="media-1" mediaKind="video" />);

      await vi.waitFor(() => expect(container).toBeEmptyDOMElement());
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'renders nothing for an external link, which has no local file to publish',
    async () => {
      const fetchImpl = stubFetch(200, { items: [] });
      const { container } = render(
        <MediaPublishControl mediaId="media-1" mediaKind="external_link" />,
      );

      await vi.waitFor(() => expect(container).toBeEmptyDOMElement());
      expect(fetchImpl).not.toHaveBeenCalled();
    },
    TEST_TIMEOUT_MS,
  );
});

describe('MediaPublishControl — status rendering', () => {
  it(
    'offers the publish action when nothing has been queued yet',
    async () => {
      stubFetch(200, { items: [] });
      render(<MediaPublishControl mediaId="media-1" mediaKind="video" />);

      expect(await screen.findByRole('button', { name: 'Опубликовать' })).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'shows a published destination with a link to the external url',
    async () => {
      stubFetch(200, {
        items: [
          publication({
            destination: 'youtube',
            status: 'published',
            external_id: 'yt-1',
            external_url: 'https://www.youtube.com/watch?v=yt-1',
          }),
        ],
      });
      render(<MediaPublishControl mediaId="media-1" mediaKind="video" />);

      await screen.findByText('YouTube');
      expect(screen.getByText('опубликовано')).toBeInTheDocument();
      const link = screen.getByRole('link', { name: 'Открыть' });
      expect(link).toHaveAttribute('href', 'https://www.youtube.com/watch?v=yt-1');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'shows a published destination without a link when no public url exists',
    async () => {
      stubFetch(200, {
        items: [publication({ status: 'published', external_id: '42', external_url: null })],
      });
      render(<MediaPublishControl mediaId="media-1" mediaKind="video" />);

      await screen.findByText('опубликовано');
      expect(screen.queryByRole('link', { name: 'Открыть' })).not.toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'presents a quota-blocked job as waiting, not as an error',
    async () => {
      stubFetch(200, {
        items: [
          publication({
            destination: 'youtube',
            status: 'queued',
            error: 'quota_exceeded',
            attempts: 3,
            next_attempt_at: '2026-07-28T07:00:00.000Z',
          }),
        ],
      });
      render(<MediaPublishControl mediaId="media-1" mediaKind="video" />);

      await screen.findByText('ждёт квоту YouTube');
      expect(screen.getByText('Достигнута суточная квота YouTube.')).toBeInTheDocument();
      expect(screen.queryByText('ошибка')).not.toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'shows a failed publication with its translated reason',
    async () => {
      stubFetch(200, {
        items: [publication({ status: 'failed', error: 'telegram_file_too_large', attempts: 1 })],
      });
      render(<MediaPublishControl mediaId="media-1" mediaKind="video" />);

      await screen.findByText('ошибка');
      expect(
        screen.getByText('Файл больше 50 МБ — Telegram не принимает такие через бота.'),
      ).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'shows an error state when the list request fails outright',
    async () => {
      stubFetch(500);
      render(<MediaPublishControl mediaId="media-1" mediaKind="video" />);

      await screen.findByText(/Не удалось загрузить статус публикаций/);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('MediaPublishControl — queueing', () => {
  it(
    'posts the selected destinations and refreshes the list',
    async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ items: [] }), { status: 200 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ items: [publication()] }), { status: 201 }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ items: [publication()] }), { status: 200 }),
        );
      vi.stubGlobal('fetch', fetchImpl);
      render(<MediaPublishControl mediaId="media-1" mediaKind="video" />);

      fireEvent.click(await screen.findByRole('button', { name: 'Опубликовать' }));
      // Telegram is preselected; deselect YouTube is not needed.
      fireEvent.click(await screen.findByRole('button', { name: 'Отправить' }));

      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
      const [url, init] = fetchImpl.mock.calls[1] ?? [];
      expect(url).toBe('/api/v1/media/media-1/publications');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual({ destinations: ['youtube', 'telegram'] });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'reports a rejected queue request without leaving the form stuck',
    async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ items: [] }), { status: 200 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: 'already_queued' }), { status: 409 }),
        );
      vi.stubGlobal('fetch', fetchImpl);
      render(<MediaPublishControl mediaId="media-1" mediaKind="video" />);

      fireEvent.click(await screen.findByRole('button', { name: 'Опубликовать' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Отправить' }));

      await screen.findByText(/Не удалось поставить в очередь/);
      expect(screen.getByRole('button', { name: 'Отправить' })).not.toBeDisabled();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses to send with no destination selected',
    async () => {
      const fetchImpl = stubFetch(200, { items: [] });
      render(<MediaPublishControl mediaId="media-1" mediaKind="video" />);

      fireEvent.click(await screen.findByRole('button', { name: 'Опубликовать' }));
      fireEvent.click(screen.getByRole('checkbox', { name: 'YouTube' }));
      fireEvent.click(screen.getByRole('checkbox', { name: 'Telegram' }));

      expect(screen.getByRole('button', { name: 'Отправить' })).toBeDisabled();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'hides the already-queued destinations from the selector',
    async () => {
      stubFetch(200, { items: [publication({ destination: 'telegram' })] });
      render(<MediaPublishControl mediaId="media-1" mediaKind="video" />);

      fireEvent.click(await screen.findByRole('button', { name: 'Опубликовать' }));

      expect(screen.getByRole('checkbox', { name: 'YouTube' })).toBeInTheDocument();
      expect(screen.queryByRole('checkbox', { name: 'Telegram' })).not.toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'does not offer the publish action once every destination is queued',
    async () => {
      stubFetch(200, {
        items: [
          publication({ id: 'pub-tg', destination: 'telegram' }),
          publication({ id: 'pub-yt', destination: 'youtube' }),
        ],
      });
      render(<MediaPublishControl mediaId="media-1" mediaKind="video" />);

      await screen.findByText('Telegram');
      expect(screen.queryByRole('button', { name: 'Опубликовать' })).not.toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );
});
