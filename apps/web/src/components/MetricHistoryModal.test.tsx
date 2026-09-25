// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MetricHistoryModal } from './MetricHistoryModal';

/** Recharts в jsdom не измеряет контейнер, поэтому график подменён заглушкой. */
vi.mock('./MetricHistoryChart', () => ({
  default: ({ data }: { data: unknown[] }) => <div data-testid="chart">{data.length}</div>,
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mockFetch(response: Response | (() => Promise<Response>)) {
  const fn = typeof response === 'function' ? response : () => Promise.resolve(response);
  const spy = vi.fn(fn);
  vi.stubGlobal('fetch', spy);
  return spy;
}

function renderModal(onClose = vi.fn()) {
  render(
    <MetricHistoryModal
      open
      onClose={onClose}
      metric="cpu"
      ramTotalBytes={8_000_000}
      diskTotalBytes={100_000_000}
    />,
  );
  return onClose;
}

describe('MetricHistoryModal', () => {
  it('exports a React component function', async () => {
    const mod = await import('./MetricHistoryModal');
    expect(typeof mod.MetricHistoryModal).toBe('function');
  });

  it('renders nothing while closed', () => {
    mockFetch(new Response(JSON.stringify({ ts: [], v: [] })));
    const { container } = render(
      <MetricHistoryModal
        open={false}
        onClose={vi.fn()}
        metric="cpu"
        ramTotalBytes={1}
        diskTotalBytes={1}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('announces loading, then draws the fetched history', async () => {
    mockFetch(
      new Response(
        JSON.stringify({
          ts: [1, 2],
          v: [
            [5000, 1, 2, 3, 4],
            [6000, 1, 2, 3, 4],
          ],
        }),
      ),
    );
    renderModal();

    expect(screen.getByRole('status')).toHaveTextContent('Загрузка истории метрики');
    await waitFor(() => expect(screen.getByTestId('chart')).toHaveTextContent('2'));
  });

  it('explains an empty 24h window instead of an empty chart', async () => {
    mockFetch(new Response(JSON.stringify({ ts: [], v: [] })));
    renderModal();
    await waitFor(() => expect(screen.getByText('Нет данных за 24 часа')).toBeInTheDocument());
  });

  it('reports a failed request and retries the same request on «Повторить»', async () => {
    let call = 0;
    const fetchSpy = mockFetch(() => {
      call += 1;
      return Promise.resolve(
        call === 1
          ? new Response('', { status: 503 })
          : new Response(JSON.stringify({ ts: [1], v: [[5000, 1, 2, 3, 4]] })),
      );
    });
    renderModal();

    await waitFor(() =>
      expect(screen.getByText('Не удалось загрузить историю')).toBeInTheDocument(),
    );
    expect(screen.getByText('HTTP 503')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    await waitFor(() => expect(screen.getByTestId('chart')).toHaveTextContent('1'));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy).toHaveBeenLastCalledWith(
      '/api/v1/host/metrics/history?seconds=86400',
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('asks to close on Escape', async () => {
    mockFetch(new Response(JSON.stringify({ ts: [], v: [] })));
    const onClose = renderModal();
    await waitFor(() => expect(screen.getByText('Нет данных за 24 часа')).toBeInTheDocument());
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
