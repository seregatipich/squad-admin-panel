// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MediaPublishControl } from './MediaPublishControl';
import { type MediaPublication, PUBLICATION_POLL_INTERVAL_MS } from './media-publications';

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

function stubFetch(status: number, body?: unknown) {
  const impl = vi.fn(() =>
    Promise.resolve(new Response(body !== undefined ? JSON.stringify(body) : null, { status })),
  );
  vi.stubGlobal('fetch', impl);
  return impl;
}

function renderControl(
  props: Partial<{
    mediaKind: 'video' | 'image' | 'external_link';
    publications: MediaPublication[];
    canManage: boolean;
  }> = {},
) {
  return render(
    <MediaPublishControl
      mediaId="media-1"
      mediaKind={props.mediaKind ?? 'video'}
      initialPublications={props.publications ?? []}
      canManage={props.canManage ?? true}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('MediaPublishControl — rendering from the evidence listing', () => {
  // Regression (#444): every instance used to fetch its own publications on
  // mount; the evidence listing now carries them.
  it(
    'renders the embedded publications without a request of its own',
    async () => {
      const fetchImpl = stubFetch(200, { items: [] });
      renderControl({
        publications: [
          publication({
            destination: 'youtube',
            status: 'published',
            external_id: 'yt-1',
            external_url: 'https://www.youtube.com/watch?v=yt-1',
          }),
        ],
      });

      expect(screen.getByText('YouTube')).toBeInTheDocument();
      expect(screen.getByText('опубликовано')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Открыть' })).toHaveAttribute(
        'href',
        'https://www.youtube.com/watch?v=yt-1',
      );
      expect(fetchImpl).not.toHaveBeenCalled();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'renders nothing for an external link, which has no local file to publish',
    () => {
      const fetchImpl = stubFetch(200, { items: [] });
      const { container } = renderControl({ mediaKind: 'external_link' });

      expect(container).toBeEmptyDOMElement();
      expect(fetchImpl).not.toHaveBeenCalled();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'shows a published destination without a link when no public url exists',
    () => {
      stubFetch(200, { items: [] });
      renderControl({
        publications: [publication({ status: 'published', external_id: '42', external_url: null })],
      });

      expect(screen.getByText('опубликовано')).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Открыть' })).not.toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'presents a quota-blocked job as waiting, not as an error',
    () => {
      stubFetch(200, { items: [] });
      renderControl({
        publications: [
          publication({
            destination: 'youtube',
            error: 'quota_exceeded',
            attempts: 3,
            next_attempt_at: '2026-07-28T07:00:00.000Z',
          }),
        ],
      });

      expect(screen.getByText('ждёт квоту YouTube')).toBeInTheDocument();
      expect(screen.getByText('Достигнута суточная квота YouTube.')).toBeInTheDocument();
      expect(screen.queryByText('ошибка')).not.toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'shows a failed publication with its translated reason',
    () => {
      stubFetch(200, { items: [] });
      renderControl({
        publications: [publication({ status: 'failed', error: 'telegram_file_too_large' })],
      });

      expect(screen.getByText('ошибка')).toBeInTheDocument();
      expect(
        screen.getByText('Файл больше 50 МБ — Telegram не принимает такие через бота.'),
      ).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );
});

describe('MediaPublishControl — permission gating', () => {
  // Regression (#440): a reader without can_manage_media was offered the
  // button and only learned on submit, through a generic failure.
  it(
    'offers no publish action to a viewer without can_manage_media',
    () => {
      stubFetch(200, { items: [] });
      const { container } = renderControl({ canManage: false });

      expect(screen.queryByRole('button', { name: 'Опубликовать' })).not.toBeInTheDocument();
      expect(container).toBeEmptyDOMElement();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'still shows the status of existing publications to such a viewer',
    () => {
      stubFetch(200, { items: [] });
      renderControl({ canManage: false, publications: [publication({ status: 'published' })] });

      expect(screen.getByText('опубликовано')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Опубликовать' })).not.toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'names the missing right and withdraws the form when the server refuses with 403',
    async () => {
      stubFetch(403, { error: 'forbidden', required: 'can_manage_media' });
      renderControl();

      fireEvent.click(screen.getByRole('button', { name: 'Опубликовать' }));
      fireEvent.click(screen.getByRole('button', { name: 'Отправить' }));

      await screen.findByText('Недостаточно прав для публикации: нужен can_manage_media.');
      expect(screen.queryByRole('button', { name: 'Отправить' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Опубликовать' })).not.toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );
});

describe('MediaPublishControl — live status', () => {
  // Regression (#444): a queued/uploading status used to hang until a reload.
  it(
    'polls while a publication is pending and stops once it settles',
    async () => {
      vi.useFakeTimers();
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              items: [publication({ status: 'uploading' })],
              can_manage_media: true,
            }),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              items: [
                publication({
                  status: 'published',
                  external_url: 'https://t.me/c/1/2',
                }),
              ],
              can_manage_media: true,
            }),
            { status: 200 },
          ),
        );
      vi.stubGlobal('fetch', fetchImpl);
      renderControl({ publications: [publication()] });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(PUBLICATION_POLL_INTERVAL_MS);
      });
      expect(screen.getByText('загружается')).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(PUBLICATION_POLL_INTERVAL_MS);
      });
      expect(screen.getByText('опубликовано')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Открыть' })).toHaveAttribute(
        'href',
        'https://t.me/c/1/2',
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(PUBLICATION_POLL_INTERVAL_MS * 3);
      });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/v1/media/media-1/publications');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'does not poll when nothing is pending',
    async () => {
      vi.useFakeTimers();
      const fetchImpl = stubFetch(200, { items: [] });
      renderControl({ publications: [publication({ status: 'published' })] });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(PUBLICATION_POLL_INTERVAL_MS * 3);
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
    TEST_TIMEOUT_MS,
  );
});

describe('MediaPublishControl — queueing', () => {
  it(
    'posts the selected destinations and shows the queued rows',
    async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ items: [publication()] }), { status: 201 }),
        );
      vi.stubGlobal('fetch', fetchImpl);
      renderControl();

      fireEvent.click(screen.getByRole('button', { name: 'Опубликовать' }));
      fireEvent.click(screen.getByRole('button', { name: 'Отправить' }));

      await screen.findByText('в очереди');
      const [url, init] = fetchImpl.mock.calls[0] ?? [];
      expect(url).toBe('/api/v1/media/media-1/publications');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual({ destinations: ['youtube', 'telegram'] });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'reports a rejected queue request without leaving the form stuck',
    async () => {
      stubFetch(409, { error: 'already_queued' });
      renderControl();

      fireEvent.click(screen.getByRole('button', { name: 'Опубликовать' }));
      fireEvent.click(screen.getByRole('button', { name: 'Отправить' }));

      await screen.findByText(/Не удалось поставить в очередь/);
      expect(screen.getByRole('button', { name: 'Отправить' })).not.toBeDisabled();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses to send with no destination selected',
    () => {
      const fetchImpl = stubFetch(200, { items: [] });
      renderControl();

      fireEvent.click(screen.getByRole('button', { name: 'Опубликовать' }));
      fireEvent.click(screen.getByRole('checkbox', { name: 'YouTube' }));
      fireEvent.click(screen.getByRole('checkbox', { name: 'Telegram' }));

      expect(screen.getByRole('button', { name: 'Отправить' })).toBeDisabled();
      expect(fetchImpl).not.toHaveBeenCalled();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'hides the already-queued destinations from the selector',
    () => {
      stubFetch(200, { items: [] });
      renderControl({ publications: [publication({ destination: 'telegram' })] });

      fireEvent.click(screen.getByRole('button', { name: 'Опубликовать' }));

      expect(screen.getByRole('checkbox', { name: 'YouTube' })).toBeInTheDocument();
      expect(screen.queryByRole('checkbox', { name: 'Telegram' })).not.toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'does not offer the publish action once every destination is queued',
    () => {
      stubFetch(200, { items: [] });
      renderControl({
        publications: [
          publication({ id: 'pub-tg', destination: 'telegram' }),
          publication({ id: 'pub-yt', destination: 'youtube' }),
        ],
      });

      expect(screen.getByText('Telegram')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Опубликовать' })).not.toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );
});

describe('MediaPublishControl — image media never offers YouTube (#439)', () => {
  it(
    'never selects or offers YouTube for an image, only Telegram',
    async () => {
      const fetchImpl = stubFetch(201, { items: [publication({ destination: 'telegram' })] });
      renderControl({ mediaKind: 'image' });

      fireEvent.click(await screen.findByRole('button', { name: 'Опубликовать' }));
      expect(screen.queryByRole('checkbox', { name: 'YouTube' })).not.toBeInTheDocument();
      expect(screen.getByRole('checkbox', { name: 'Telegram' })).toBeChecked();

      fireEvent.click(screen.getByRole('button', { name: 'Отправить' }));
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
      const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
      expect(JSON.parse(String(init.body))).toEqual({ destinations: ['telegram'] });
    },
    TEST_TIMEOUT_MS,
  );
});

describe('MediaPublishControl — a failed publication can be retried, not stuck forever (#439)', () => {
  it(
    'offers to remove a failed publication, freeing its destination for a new attempt',
    async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ items: [] }), { status: 200 }));
      vi.stubGlobal('fetch', fetchImpl);
      renderControl({
        publications: [
          publication({
            destination: 'youtube',
            status: 'failed',
            error: 'youtube_auth_failed',
          }),
        ],
      });

      fireEvent.click(await screen.findByRole('button', { name: 'Убрать' }));

      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
      const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe('/api/v1/media/media-1/publications/youtube');
      expect(init.method).toBe('DELETE');

      // Once removed, the destination is free again and the publish action returns.
      await screen.findByRole('button', { name: 'Опубликовать' });
    },
    TEST_TIMEOUT_MS,
  );
});
