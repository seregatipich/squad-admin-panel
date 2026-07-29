// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
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

function mockFetch(serversStatus = 200) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith('/api/v1/servers')) {
      if (serversStatus !== 200) {
        return Promise.resolve(new Response(null, { status: serversStatus }));
      }
      return Promise.resolve(new Response(JSON.stringify(SERVERS), { status: 200 }));
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ReportPlayerSection', () => {
  it(
    'renders the «Пожаловаться» button once the server list loads',
    async () => {
      vi.stubGlobal('fetch', mockFetch());
      render(<ReportPlayerSection playerId="player-1" />);
      const button = await screen.findByRole('button', { name: /пожаловаться/i });
      expect(button).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'opens a modal with the required fields on click',
    async () => {
      vi.stubGlobal('fetch', mockFetch());
      render(<ReportPlayerSection playerId="player-1" />);
      const button = await screen.findByRole('button', { name: /пожаловаться/i });
      fireEvent.click(button);

      expect(await screen.findByLabelText(/^сервер$/i)).toBeInTheDocument();
      expect(screen.getByText(/текст жалобы/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /отправить жалобу/i })).toBeDisabled();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'renders nothing when the servers fetch is unauthorized (401)',
    async () => {
      vi.stubGlobal('fetch', mockFetch(401));
      const { container } = render(<ReportPlayerSection playerId="player-1" />);
      await waitFor(() => expect(container).toBeEmptyDOMElement());
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'renders nothing when the servers fetch is forbidden (403)',
    async () => {
      vi.stubGlobal('fetch', mockFetch(403));
      const { container } = render(<ReportPlayerSection playerId="player-1" />);
      await waitFor(() => expect(container).toBeEmptyDOMElement());
    },
    TEST_TIMEOUT_MS,
  );
});
