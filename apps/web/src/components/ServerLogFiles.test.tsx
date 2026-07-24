// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServerLogFiles } from './ServerLogFiles';

const TEST_TIMEOUT_MS = 15_000;
const SERVER_ID = '019dbac8-ceb0-77ab-859b-bfa9a282ee2c';

const FILES = [
  { name: 'SquadGame.log', size: 4096, mtime: '2026-07-24T10:00:00Z', is_live: true },
  {
    name: 'SquadGame-2026.07.23-11.00.00.log',
    size: 10_485_760,
    mtime: '2026-07-23T11:00:00Z',
    is_live: false,
  },
];

function mockFetch(files = FILES) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === `/api/v1/servers/${SERVER_ID}/logs/files`) {
      return Promise.resolve(new Response(JSON.stringify({ files }), { status: 200 }));
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
}

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ServerLogFiles', () => {
  it('renders nothing without the download permission', () => {
    const { container } = render(<ServerLogFiles serverId={SERVER_ID} canDownload={false} />);
    expect(container).toBeEmptyDOMElement();
    expect(fetch).not.toHaveBeenCalled();
  });

  it(
    'lists the log files with a live badge and per-file download links',
    async () => {
      render(<ServerLogFiles serverId={SERVER_ID} canDownload={true} />);

      const liveName = await screen.findByText('SquadGame.log');
      const liveRow = liveName.closest('tr');
      if (!liveRow) throw new Error('live row not found');
      // "live" badge is present on the active file only.
      expect(within(liveRow).getByText(/live/i)).toBeInTheDocument();

      const rotatedName = screen.getByText('SquadGame-2026.07.23-11.00.00.log');
      const rotatedRow = rotatedName.closest('tr');
      if (!rotatedRow) throw new Error('rotated row not found');
      expect(within(rotatedRow).queryByText(/live/i)).toBeNull();
      // Human-readable size for the 10 MiB rotated file.
      expect(within(rotatedRow).getByText(/10(\.0)?\s?MB/i)).toBeInTheDocument();

      const liveLink = within(liveRow).getByRole('link');
      expect(liveLink).toHaveAttribute(
        'href',
        `/api/v1/servers/${SERVER_ID}/logs/files/SquadGame.log/download`,
      );
      expect(liveLink).toHaveAttribute('download');

      const rotatedLink = within(rotatedRow).getByRole('link');
      expect(rotatedLink).toHaveAttribute(
        'href',
        `/api/v1/servers/${SERVER_ID}/logs/files/SquadGame-2026.07.23-11.00.00.log/download`,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'shows an empty-state when there are no log files',
    async () => {
      vi.stubGlobal('fetch', mockFetch([]));
      render(<ServerLogFiles serverId={SERVER_ID} canDownload={true} />);
      await waitFor(() => {
        expect(screen.getByText(/нет файлов/i)).toBeInTheDocument();
      });
    },
    TEST_TIMEOUT_MS,
  );
});
