// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MediaPublishingIntegrationPage from './page';

const TEST_TIMEOUT_MS = 15_000;

function status(overrides: Record<string, boolean> = {}) {
  return {
    youtube_configured: false,
    telegram_configured: false,
    release_local_file: false,
    ...overrides,
  };
}

function stubFetch(httpStatus: number, body?: unknown) {
  const impl = vi.fn(() =>
    Promise.resolve(
      new Response(body !== undefined ? JSON.stringify(body) : null, { status: httpStatus }),
    ),
  );
  vi.stubGlobal('fetch', impl);
  return impl;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('MediaPublishingIntegrationPage', () => {
  it(
    'reports both destinations as not configured on a bare deployment',
    async () => {
      stubFetch(200, status());
      render(<MediaPublishingIntegrationPage />);

      await screen.findByText('Публикация медиа');
      expect(screen.getAllByText('не настроено')).toHaveLength(2);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'reports a configured destination',
    async () => {
      stubFetch(200, status({ telegram_configured: true }));
      render(<MediaPublishingIntegrationPage />);

      await screen.findByText('настроено');
      expect(screen.getByText('не настроено')).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'never renders a credential value, only its presence',
    async () => {
      stubFetch(200, status({ youtube_configured: true, telegram_configured: true }));
      const { container } = render(<MediaPublishingIntegrationPage />);

      await screen.findAllByText('настроено');
      expect(container.textContent).not.toMatch(/TOKEN|SECRET|GOCSPX|[0-9]{6,}:[A-Za-z]/);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'reflects the stored release-local-file switch',
    async () => {
      stubFetch(200, status({ release_local_file: true }));
      render(<MediaPublishingIntegrationPage />);

      const toggle = await screen.findByRole('switch', {
        name: /Освобождать локальный файл/,
      });
      expect(toggle).toBeChecked();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'persists a change to the release-local-file switch',
    async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify(status()), { status: 200 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify(status({ release_local_file: true })), { status: 200 }),
        );
      vi.stubGlobal('fetch', fetchImpl);
      render(<MediaPublishingIntegrationPage />);

      const toggle = await screen.findByRole('switch', {
        name: /Освобождать локальный файл/,
      });
      fireEvent.click(toggle);

      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
      const [url, init] = fetchImpl.mock.calls[1] ?? [];
      expect(url).toBe('/api/v1/integrations/media-publishing');
      expect(init.method).toBe('PATCH');
      expect(JSON.parse(init.body)).toEqual({ release_local_file: true });
      await vi.waitFor(() => expect(toggle).toBeChecked());
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'surfaces a rejected switch change and leaves the stored value showing',
    async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify(status()), { status: 200 }))
        .mockResolvedValueOnce(new Response(null, { status: 403 }));
      vi.stubGlobal('fetch', fetchImpl);
      render(<MediaPublishingIntegrationPage />);

      const toggle = await screen.findByRole('switch', {
        name: /Освобождать локальный файл/,
      });
      fireEvent.click(toggle);

      await screen.findByText(/Не удалось сохранить настройку/);
      expect(toggle).not.toBeChecked();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'renders nothing when the caller has no panel access',
    async () => {
      stubFetch(403);
      const { container } = render(<MediaPublishingIntegrationPage />);

      await vi.waitFor(() => expect(container).toBeEmptyDOMElement());
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'shows an error state when the status request fails',
    async () => {
      stubFetch(500);
      render(<MediaPublishingIntegrationPage />);

      await screen.findByText(/Не удалось загрузить настройки публикации/);
    },
    TEST_TIMEOUT_MS,
  );
});
