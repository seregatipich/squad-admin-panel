// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/use-live-bus', () => ({ useLiveSubscription: vi.fn() }));

import { MapWidget } from './map-widget';

const TEST_TIMEOUT_MS = 15_000;

const CATALOG = [
  {
    id: 'l1',
    name: 'Yehorivka RAAS v11',
    map: 'Yehorivka',
    gamemode: 'RAAS',
    deprecated: false,
  },
  {
    id: 'l2',
    name: 'Old Layer AAS v1',
    map: 'Old Map',
    gamemode: 'AAS',
    deprecated: true,
  },
];

function mockFetch(
  overrides: { map?: () => Promise<Response>; post?: (url: string) => Promise<Response> } = {},
) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (!init || init.method === undefined) {
      if (url.endsWith('/map')) {
        return overrides.map
          ? overrides.map()
          : Promise.resolve(
              new Response(JSON.stringify({ current: null, next: null, match_started_at: null }), {
                status: 200,
              }),
            );
      }
      if (url.endsWith('/api/v1/layers')) {
        return Promise.resolve(new Response(JSON.stringify({ rows: CATALOG }), { status: 200 }));
      }
    }
    if (init?.method === 'POST') {
      return overrides.post
        ? overrides.post(url)
        : Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
}

/**
 * jsdom знает `<dialog>`, но не реализует `showModal()`/`close()`. Выбор слоя и
 * подтверждения построены на нативном элементе, поэтому тест воспроизводит
 * ровно то, на что примитивы опираются.
 */
if (typeof HTMLDialogElement.prototype.showModal !== 'function') {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
}

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('MapWidget', () => {
  it(
    'renders "По ротации" when there is no next layer, and hides action buttons without canChangeMap',
    async () => {
      render(<MapWidget serverId="srv-1" canChangeMap={false} />);
      await screen.findByText('По ротации');
      expect(screen.queryByRole('button', { name: /следующая/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /сменить сейчас/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /завершить матч/i })).not.toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'shows the current layer and elapsed match time',
    async () => {
      vi.stubGlobal(
        'fetch',
        mockFetch({
          map: () =>
            Promise.resolve(
              new Response(
                JSON.stringify({
                  current: {
                    layer: 'Yehorivka RAAS v11',
                    map: 'Yehorivka',
                    gamemode: 'RAAS',
                    deprecated: false,
                  },
                  next: null,
                  match_started_at: new Date(Date.now() - 5 * 60_000).toISOString(),
                }),
                { status: 200 },
              ),
            ),
        }),
      );
      render(<MapWidget serverId="srv-1" canChangeMap={false} />);
      await screen.findByText('Yehorivka RAAS v11');
      await screen.findByText(/идёт \d+ мин/);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'renders the three gated action buttons when canChangeMap is true',
    async () => {
      render(<MapWidget serverId="srv-1" canChangeMap={true} />);
      await screen.findByRole('button', { name: /следующая/i });
      expect(screen.getByRole('button', { name: /сменить сейчас/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /завершить матч/i })).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'shows the deprecated tag in the picker and disables submit until the confirm checkbox is checked',
    async () => {
      render(<MapWidget serverId="srv-1" canChangeMap={true} />);
      fireEvent.click(await screen.findByRole('button', { name: /следующая/i }));

      const deprecatedRow = await screen.findByText('Old Layer AAS v1');
      expect(await screen.findByText('устаревший')).toBeInTheDocument();
      fireEvent.click(deprecatedRow);

      const submit = screen.getByRole('button', { name: /применить/i });
      expect(submit).toBeDisabled();

      const confirmCheckbox = screen.getByRole('checkbox', { name: /понимаю, слой устаревший/i });
      fireEvent.click(confirmCheckbox);
      expect(submit).toBeEnabled();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'enables submit immediately for a non-deprecated layer',
    async () => {
      render(<MapWidget serverId="srv-1" canChangeMap={true} />);
      fireEvent.click(await screen.findByRole('button', { name: /следующая/i }));

      fireEvent.click(await screen.findByText('Yehorivka RAAS v11'));
      const submit = screen.getByRole('button', { name: /применить/i });
      expect(submit).toBeEnabled();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'posts to /map/next with the selected layer on submit',
    async () => {
      const post = vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })),
      );
      vi.stubGlobal('fetch', mockFetch({ post }));

      render(<MapWidget serverId="srv-1" canChangeMap={true} />);
      fireEvent.click(await screen.findByRole('button', { name: /следующая/i }));
      fireEvent.click(await screen.findByText('Yehorivka RAAS v11'));
      fireEvent.click(screen.getByRole('button', { name: /применить/i }));

      await waitFor(() => expect(post).toHaveBeenCalledWith('/api/v1/servers/srv-1/map/next'));
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'asks for a separate confirmation before changing the layer mid-match, and only then posts',
    async () => {
      const post = vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })),
      );
      vi.stubGlobal('fetch', mockFetch({ post }));

      render(<MapWidget serverId="srv-1" canChangeMap={true} />);
      fireEvent.click(await screen.findByRole('button', { name: /сменить сейчас/i }));
      fireEvent.click(await screen.findByText('Yehorivka RAAS v11'));
      fireEvent.click(screen.getByRole('button', { name: /применить/i }));

      // Матч сбрасывается — вопрос задаётся отдельным диалогом, а не окном браузера.
      expect(
        await screen.findByRole('heading', { name: 'Сменить карту сейчас?' }),
      ).toBeInTheDocument();
      expect(post).not.toHaveBeenCalled();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Сменить карту' }));
      });
      await waitFor(() => expect(post).toHaveBeenCalledWith('/api/v1/servers/srv-1/map/change'));
      expect(await screen.findByText('Карта сменена')).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'leaves the layer untouched when the mid-match change is declined',
    async () => {
      const post = vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })),
      );
      vi.stubGlobal('fetch', mockFetch({ post }));

      render(<MapWidget serverId="srv-1" canChangeMap={true} />);
      fireEvent.click(await screen.findByRole('button', { name: /сменить сейчас/i }));
      fireEvent.click(await screen.findByText('Yehorivka RAAS v11'));
      fireEvent.click(screen.getByRole('button', { name: /применить/i }));

      const heading = await screen.findByRole('heading', { name: 'Сменить карту сейчас?' });
      const confirmDialog = heading.closest('dialog');
      expect(confirmDialog).not.toBeNull();
      await act(async () => {
        fireEvent.click(
          within(confirmDialog as HTMLElement).getAllByRole('button', { name: 'Отмена' })[0],
        );
      });

      expect(post).not.toHaveBeenCalled();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'ends the match through a confirmation dialog',
    async () => {
      const post = vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })),
      );
      vi.stubGlobal('fetch', mockFetch({ post }));

      render(<MapWidget serverId="srv-1" canChangeMap={true} />);
      fireEvent.click(await screen.findByRole('button', { name: /завершить матч/i }));
      expect(await screen.findByRole('heading', { name: 'Завершить матч?' })).toBeInTheDocument();
      expect(post).not.toHaveBeenCalled();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Завершить' }));
      });
      await waitFor(() => expect(post).toHaveBeenCalledWith('/api/v1/servers/srv-1/map/end-match'));
      expect(await screen.findByText('Матч завершён')).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );
});
