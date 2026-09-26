// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LiveEvent } from '@/lib/live-bus';
import { useLiveSubscription } from '@/lib/use-live-bus';
import { EvidenceSection } from './EvidenceSection';

vi.mock('@/lib/use-live-bus', () => ({ useLiveSubscription: vi.fn() }));

type MediaUploadedEvent = Extract<LiveEvent, { type: 'media.uploaded' }>;

let uploadedHandler: ((event: MediaUploadedEvent) => void) | undefined;

const EVIDENCE_RESPONSE = {
  items: [
    {
      link: {
        id: 'link-1',
        entity_type: 'moderation_action',
        entity_id: 'action-1',
        created_at: '2026-07-09T10:00:00.000Z',
      },
      media: {
        id: 'media-1',
        kind: 'video',
        original_filename: 'clip.mp4',
        external_url: null,
        title: 'Аимбот на записи',
        upload_token_id: null,
        uploader_player_id: 'admin-1',
      },
    },
  ],
};

const ANONYMOUS_EVIDENCE_RESPONSE = {
  items: [
    {
      link: {
        id: 'link-2',
        entity_type: 'player',
        entity_id: 'player-1',
        created_at: '2026-07-10T10:00:00.000Z',
      },
      media: {
        id: 'media-2',
        kind: 'image',
        original_filename: 'proof.png',
        external_url: null,
        title: null,
        upload_token_id: 'token-9',
        uploader_player_id: null,
      },
    },
  ],
};

/** Stubs `fetch` with a URL-dispatched handler so list loads and mints can differ. */
function stubFetch(handler: (url: string, init?: RequestInit) => Response): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => Promise.resolve(handler(url, init))),
  );
}

function listOnly(body: unknown, status = 200) {
  return () => new Response(JSON.stringify(body), { status });
}

const LIST_URL = '/api/v1/players/player-1/media';

/**
 * Fetch stub for the live-event tests: the evidence list for this card and an
 * empty publication list for the `MediaPublishControl` each video mounts.
 */
function stubListAndPublications() {
  const fetchMock = vi.fn((url: string) =>
    Promise.resolve(
      new Response(JSON.stringify(url === LIST_URL ? EVIDENCE_RESPONSE : { items: [] }), {
        status: 200,
      }),
    ),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/**
 * Number of evidence-list loads. Counting every fetch also counted the
 * publication status request of `MediaPublishControl`: it starts from a passive
 * effect that React flushes on its own scheduler tick, before or after
 * `findByText` resolves depending on load, so the baseline was 1 or 2 and the
 * exact-count assertion failed under load (expected 3 to be 2).
 */
function listLoads(fetchMock: ReturnType<typeof stubListAndPublications>): number {
  return fetchMock.mock.calls.filter(([url]) => url === LIST_URL).length;
}

beforeEach(() => {
  vi.mocked(useLiveSubscription).mockImplementation((_type, handler) => {
    uploadedHandler = handler as (event: MediaUploadedEvent) => void;
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  uploadedHandler = undefined;
});

describe('EvidenceSection', () => {
  it('is a valid React component', () => {
    expect(EvidenceSection).toBeDefined();
    expect(typeof EvidenceSection).toBe('function');
  });

  it('renders the evidence list from a mocked fetch', async () => {
    stubFetch(listOnly(EVIDENCE_RESPONSE));

    render(<EvidenceSection playerId="player-1" />);
    expect(screen.getByRole('status')).toHaveTextContent('Загрузка доказательств');

    await screen.findByText('Аимбот на записи');
    const heading = screen.getByRole('heading', { name: 'Доказательства' });
    expect(heading.parentElement).toHaveTextContent('1');
  });

  it('hides entirely on 403', async () => {
    stubFetch(listOnly({ error: 'forbidden' }, 403));

    const { container } = render(<EvidenceSection playerId="player-1" />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('renders a video element whose source points at the media stream route', async () => {
    stubFetch(listOnly(EVIDENCE_RESPONSE));

    render(<EvidenceSection playerId="player-1" />);
    await screen.findByText('Аимбот на записи');

    const video = document.querySelector('video');
    expect(video).toBeInTheDocument();
    expect(video?.getAttribute('src')).toBe('/api/v1/media/media-1/stream');
  });

  it('marks evidence uploaded through a one-time link as anonymous', async () => {
    stubFetch(listOnly(ANONYMOUS_EVIDENCE_RESPONSE));

    render(<EvidenceSection playerId="player-1" />);
    await screen.findByText('proof.png');
    expect(screen.getByText('загружено по ссылке, аноним')).toBeInTheDocument();
  });

  it('mints a one-time upload link bound to this player and shows it once', async () => {
    stubFetch((url, init) => {
      if (url.startsWith('/api/v1/media/upload-tokens')) {
        expect(init?.method).toBe('POST');
        expect(JSON.parse(String(init?.body))).toEqual({
          target_entity_type: 'player',
          target_entity_id: 'player-1',
        });
        return new Response(
          JSON.stringify({
            id: 'token-1',
            upload_url: 'https://panel.test/upload/raw-token-1',
            token: 'raw-token-1',
            expires_at: '2026-07-27T12:00:00.000Z',
            max_size_bytes: 1024,
            target_entity_type: 'player',
            target_entity_id: 'player-1',
          }),
          { status: 201 },
        );
      }
      return new Response(JSON.stringify(EVIDENCE_RESPONSE), { status: 200 });
    });

    render(<EvidenceSection playerId="player-1" />);
    await screen.findByText('Аимбот на записи');

    await userEvent.click(screen.getByRole('button', { name: 'Получить ссылку для загрузки' }));

    const field = await screen.findByTestId('upload-link-value');
    expect(field).toHaveValue('https://panel.test/upload/raw-token-1');
    expect(screen.getByText(/показывается один раз/)).toBeInTheDocument();
  });

  it('surfaces a mint failure without exposing a link', async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/v1/media/upload-tokens')) {
        return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 });
      }
      return new Response(JSON.stringify(EVIDENCE_RESPONSE), { status: 200 });
    });

    render(<EvidenceSection playerId="player-1" />);
    await screen.findByText('Аимбот на записи');

    await userEvent.click(screen.getByRole('button', { name: 'Получить ссылку для загрузки' }));

    expect(await screen.findByText('Не удалось создать ссылку.')).toBeInTheDocument();
    expect(screen.queryByTestId('upload-link-value')).not.toBeInTheDocument();
  });

  it('reloads the list when a media.uploaded event arrives for this player', async () => {
    const fetchMock = stubListAndPublications();

    render(<EvidenceSection playerId="player-1" />);
    await screen.findByText('Аимбот на записи');
    const loadsBefore = listLoads(fetchMock);

    act(() => {
      uploadedHandler?.({
        type: 'media.uploaded',
        ts: '2026-07-27T00:00:00.000Z',
        data: {
          player_id: 'admin-1',
          media_id: 'media-9',
          token_id: 'token-9',
          target_entity_type: 'player',
          target_entity_id: 'player-1',
        },
      });
    });

    await waitFor(() => expect(listLoads(fetchMock)).toBe(loadsBefore + 1));
  });

  it('ignores a media.uploaded event bound to a different player card', async () => {
    const fetchMock = stubListAndPublications();

    render(<EvidenceSection playerId="player-1" />);
    await screen.findByText('Аимбот на записи');
    const loadsBefore = listLoads(fetchMock);

    act(() => {
      uploadedHandler?.({
        type: 'media.uploaded',
        ts: '2026-07-27T00:00:00.000Z',
        data: {
          player_id: 'admin-1',
          media_id: 'media-8',
          token_id: 'token-8',
          target_entity_type: 'player',
          target_entity_id: 'player-2',
        },
      });
    });

    // Событие своей карточки, отправленное следом, доказывает, что у чужого
    // была возможность вызвать перезагрузку и он ею не воспользовался: к
    // моменту, когда счётчик вырос на единицу, оба события уже обработаны.
    // Считаются только загрузки списка (см. `listLoads`): запрос статуса
    // публикаций приходит в своё время и к событиям не относится.
    act(() => {
      uploadedHandler?.({
        type: 'media.uploaded',
        ts: '2026-07-27T00:00:01.000Z',
        data: {
          player_id: 'admin-1',
          media_id: 'media-9',
          token_id: 'token-9',
          target_entity_type: 'player',
          target_entity_id: 'player-1',
        },
      });
    });

    await waitFor(() => expect(listLoads(fetchMock)).toBe(loadsBefore + 1));
    expect(listLoads(fetchMock)).toBe(loadsBefore + 1);
  });
});
