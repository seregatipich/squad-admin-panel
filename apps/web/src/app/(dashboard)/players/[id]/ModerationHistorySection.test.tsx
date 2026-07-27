// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ModerationHistorySection } from './ModerationHistorySection';

const VIEWER_ID = 'viewer-1';

function action(overrides: Record<string, unknown> = {}) {
  return {
    id: 'action-1',
    action_type: 'ban',
    reason: 'aimbot',
    context: {},
    report_id: null,
    created_at: '2026-07-27T10:00:00.000Z',
    reverted_at: null,
    server: { id: 'server-1', name: 'Main #1' },
    author: { kind: 'player', id: 'mod-1', name: 'Модератор Вася' },
    evidence: [],
    evidence_count: 0,
    ...overrides,
  };
}

function evidence(overrides: Record<string, unknown> = {}) {
  return {
    id: 'media-1',
    kind: 'video',
    external_url: null,
    original_filename: 'clip.mp4',
    mime_type: 'video/mp4',
    size_bytes: 1024,
    title: 'Аимбот на записи',
    linked_by_player_id: VIEWER_ID,
    linked_at: '2026-07-27T10:05:00.000Z',
    ...overrides,
  };
}

function stubFetch(body: unknown, status = 200) {
  const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status })));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ModerationHistorySection', () => {
  it('renders the action list with type, reason, author, server and time', async () => {
    stubFetch({ actions: [action()] });

    render(<ModerationHistorySection playerId="player-1" viewerPlayerId={VIEWER_ID} />);
    expect(screen.getByText('Загрузка…')).toBeInTheDocument();

    await screen.findByText('Бан');
    expect(screen.getByText('История модерации (1)')).toBeInTheDocument();
    expect(screen.getByText('aimbot')).toBeInTheDocument();
    expect(screen.getByText(/Модератор Вася/)).toBeInTheDocument();
    expect(screen.getByText(/Main #1/)).toBeInTheDocument();
    expect(screen.getByText(/27\.07\.2026/)).toBeInTheDocument();
  });

  it('shows the empty state when the player has no moderation actions', async () => {
    stubFetch({ actions: [] });

    render(<ModerationHistorySection playerId="player-1" viewerPlayerId={VIEWER_ID} />);
    await screen.findByText('Действий модерации нет.');
  });

  it('hides entirely on 403', async () => {
    stubFetch({ error: 'forbidden' }, 403);

    const { container } = render(
      <ModerationHistorySection playerId="player-1" viewerPlayerId={VIEWER_ID} />,
    );
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('surfaces a transport error', async () => {
    stubFetch({ error: 'boom' }, 500);

    render(<ModerationHistorySection playerId="player-1" viewerPlayerId={VIEWER_ID} />);
    await screen.findByText(/Ошибка: HTTP 500/);
  });

  it('labels a system-issued action with its worker label', async () => {
    stubFetch({
      actions: [
        action({
          action_type: 'name_kick',
          author: { kind: 'system', label: 'banname-worker' },
          reason: null,
        }),
      ],
    });

    render(<ModerationHistorySection playerId="player-1" viewerPlayerId={VIEWER_ID} />);
    await screen.findByText('Кик за ник');
    expect(screen.getByText(/banname-worker/)).toBeInTheDocument();
  });

  it('marks a reverted action', async () => {
    stubFetch({ actions: [action({ reverted_at: '2026-07-27T12:00:00.000Z' })] });

    render(<ModerationHistorySection playerId="player-1" viewerPlayerId={VIEWER_ID} />);
    await screen.findByText('отменено');
  });

  it('plays an uploaded video evidence clip inline through the media stream route', async () => {
    stubFetch({ actions: [action({ evidence: [evidence()], evidence_count: 1 })] });

    render(<ModerationHistorySection playerId="player-1" viewerPlayerId={VIEWER_ID} />);
    await screen.findByText('Аимбот на записи');

    const video = document.querySelector('video');
    expect(video).toBeInTheDocument();
    expect(video?.getAttribute('src')).toBe('/api/v1/media/media-1/stream');
  });

  it('renders image evidence inline and external-link evidence as an anchor', async () => {
    stubFetch({
      actions: [
        action({
          evidence: [
            evidence({ id: 'media-img', kind: 'image', title: 'Скриншот' }),
            evidence({
              id: 'media-ext',
              kind: 'external_link',
              external_url: 'https://clips.example.com/abc',
              title: null,
              original_filename: 'clip.mp4',
            }),
          ],
          evidence_count: 2,
        }),
      ],
    });

    render(<ModerationHistorySection playerId="player-1" viewerPlayerId={VIEWER_ID} />);
    await screen.findByText('Скриншот');

    const img = document.querySelector('img');
    expect(img?.getAttribute('src')).toBe('/api/v1/media/media-img/stream');

    const anchor = screen.getByRole('link', { name: 'https://clips.example.com/abc' });
    expect(anchor).toHaveAttribute('href', 'https://clips.example.com/abc');
  });

  it('hides «Открепить» on evidence linked by somebody else', async () => {
    stubFetch({
      actions: [
        action({
          evidence: [evidence({ linked_by_player_id: 'someone-else' })],
          evidence_count: 1,
        }),
      ],
    });

    render(<ModerationHistorySection playerId="player-1" viewerPlayerId={VIEWER_ID} />);
    await screen.findByText('Аимбот на записи');
    expect(screen.queryByRole('button', { name: 'Открепить' })).not.toBeInTheDocument();
  });

  it('detaches your own evidence link and drops it from the list', async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            actions: [action({ evidence: [evidence()], evidence_count: 1 })],
          }),
          { status: 200 },
        ),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ModerationHistorySection playerId="player-1" viewerPlayerId={VIEWER_ID} />);
    const button = await screen.findByRole('button', { name: 'Открепить' });
    fireEvent.click(button);

    await waitFor(() => expect(screen.queryByText('Аимбот на записи')).not.toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/media/media-1/links?entity_type=moderation_action&entity_id=action-1',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('keeps the evidence and reports a refusal when detaching is forbidden', async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        return Promise.resolve(
          new Response(JSON.stringify({ error: 'forbidden', required: 'can_manage_media' }), {
            status: 403,
          }),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            actions: [action({ evidence: [evidence()], evidence_count: 1 })],
          }),
          { status: 200 },
        ),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ModerationHistorySection playerId="player-1" viewerPlayerId={VIEWER_ID} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Открепить' }));

    await screen.findByText('Недостаточно прав, чтобы открепить это доказательство.');
    expect(screen.getByText('Аимбот на записи')).toBeInTheDocument();
  });

  it('never offers «Открепить» when the viewer is not identified', async () => {
    stubFetch({
      actions: [action({ evidence: [evidence()], evidence_count: 1 })],
    });

    render(<ModerationHistorySection playerId="player-1" viewerPlayerId={null} />);
    await screen.findByText('Аимбот на записи');
    expect(screen.queryByRole('button', { name: 'Открепить' })).not.toBeInTheDocument();
  });
});
