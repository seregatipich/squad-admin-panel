// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react';
import { Suspense } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/MetricsChart', () => ({
  MetricsChart: ({ label, points }: { label: string; points: unknown[] }) => (
    <figure aria-label={label} data-points={points.length} />
  ),
}));

import MonitoringPage from './page';

/** Адреса, по которым страница сходила за метриками, в порядке обращения. */
function requestedUrls(): string[] {
  const calls = (globalThis.fetch as unknown as { mock: { calls: [string][] } }).mock.calls;
  return calls.map(([url]) => url);
}

function installFetch(reply: () => Promise<Response>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => reply()),
  );
}

function metricsResponse(points: unknown[]): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify({ points }), { status: 200 }));
}

const POINT = {
  timestamp: '2026-08-22T10:00:00.000Z',
  cpu_percent: 41.5,
  mem_bytes: 2_147_483_648,
  mem_percent: 25,
  pids: 12,
};

async function renderPage() {
  await act(async () => {
    render(
      <Suspense fallback={null}>
        <MonitoringPage params={Promise.resolve({ id: 'abc' })} />
      </Suspense>,
    );
  });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('MonitoringPage', () => {
  it('is a valid React component', () => {
    expect(MonitoringPage).toBeDefined();
    expect(typeof MonitoringPage).toBe('function');
  });

  it('показывает заглушку загрузки, а затем графики', async () => {
    let resolveFirst: ((r: Response) => void) | undefined;
    installFetch(
      () =>
        new Promise<Response>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    await renderPage();

    expect(screen.getByRole('status')).toHaveTextContent('Загружаем метрики сервера');
    expect(screen.queryByRole('figure', { name: 'CPU' })).not.toBeInTheDocument();

    await act(async () => {
      resolveFirst?.(new Response(JSON.stringify({ points: [POINT] }), { status: 200 }));
    });

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByRole('figure', { name: 'CPU' })).toBeInTheDocument();
    expect(screen.getByRole('figure', { name: 'Память' })).toBeInTheDocument();
  });

  it('рисует график тикрейта только когда он приходит в точках', async () => {
    installFetch(() => metricsResponse([POINT]));
    await renderPage();
    expect(screen.queryByRole('figure', { name: 'Tickrate' })).not.toBeInTheDocument();

    cleanup();
    installFetch(() => metricsResponse([{ ...POINT, tickrate: 49.5 }]));
    await renderPage();
    expect(screen.getByRole('figure', { name: 'Tickrate' })).toBeInTheDocument();
  });

  it('переключатель периода запрашивает метрики за выбранный интервал', async () => {
    installFetch(() => metricsResponse([POINT]));
    await renderPage();
    const firstSince = new URL(requestedUrls()[0] ?? '', 'http://x').searchParams.get('since');

    await act(async () => {
      screen.getByRole('tab', { name: '24 ч' }).click();
    });

    const lastUrl = requestedUrls().at(-1) ?? '';
    const lastSince = new URL(lastUrl, 'http://x').searchParams.get('since');
    expect(screen.getByRole('tab', { name: '24 ч' })).toHaveAttribute('aria-selected', 'true');
    expect(lastSince).not.toBeNull();
    expect(new Date(lastSince as string).getTime()).toBeLessThan(
      new Date(firstSince as string).getTime(),
    );
  });

  it('ошибку запроса показывает полосой с действием «Повторить»', async () => {
    installFetch(() => Promise.resolve(new Response('boom', { status: 503 })));
    await renderPage();

    const banner = screen.getByRole('alert');
    expect(banner).toHaveTextContent('Метрики не загрузились');
    expect(banner).toHaveTextContent('HTTP 503');

    installFetch(() => metricsResponse([POINT]));
    await act(async () => {
      screen.getByRole('button', { name: 'Повторить' }).click();
    });

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('figure', { name: 'CPU' })).toBeInTheDocument();
  });
});
