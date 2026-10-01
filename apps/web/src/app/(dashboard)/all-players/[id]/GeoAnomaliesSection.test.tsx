// @vitest-environment happy-dom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GeoAnomaliesSection } from './GeoAnomaliesSection';

const CONFIG = { country_switch_window_hours: 6, multi_country_threshold: 3 };

const CLEAN_RESPONSE = {
  config: CONFIG,
  distinct_country_count: 1,
  multi_country: false,
  has_recent_switch: false,
  switches: [],
  points: [],
};

const SWITCH_RESPONSE = {
  config: CONFIG,
  distinct_country_count: 3,
  multi_country: true,
  has_recent_switch: true,
  switches: [
    {
      from_country_code: 'RU',
      from_country_name: 'Россия',
      to_country_code: 'DE',
      to_country_name: 'Германия',
      to_observed_at: '2026-03-01T10:00:00.000Z',
      gap_hours: 2.4,
      within_window: true,
    },
    {
      from_country_code: 'DE',
      from_country_name: null,
      to_country_code: 'US',
      to_country_name: 'США',
      to_observed_at: '2026-03-10T10:00:00.000Z',
      gap_hours: 72,
      within_window: false,
    },
  ],
  points: [
    {
      ip: '10.0.0.1',
      country_code: 'RU',
      country_name: 'Россия',
      latitude: 55,
      longitude: 37,
      last_seen_at: '2026-02-01T10:00:00.000Z',
    },
    {
      ip: '10.0.0.2',
      country_code: 'DE',
      country_name: 'Германия',
      latitude: 52,
      longitude: 13,
      last_seen_at: '2026-03-01T10:00:00.000Z',
    },
  ],
};

function stubFetch(handler: () => Response) {
  const fetchMock = vi.fn((_input: RequestInfo | URL) => Promise.resolve(handler()));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('GeoAnomaliesSection', () => {
  it('shows a loading skeleton while the request is pending', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => undefined)),
    );
    render(<GeoAnomaliesSection playerId="p-1" />);

    expect(screen.getByRole('status')).toHaveTextContent('Загрузка гео-аномалий');
  });

  it('requests the anomalies of the given player', async () => {
    const fetchMock = stubFetch(() => new Response(JSON.stringify(CLEAN_RESPONSE)));
    render(<GeoAnomaliesSection playerId="p-1" />);

    await screen.findByText('Гео-аномалии');
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('/api/v1/players/p-1/geo-anomalies');
  });

  it('reports no anomalies and draws no map or timeline for a clean history', async () => {
    stubFetch(() => new Response(JSON.stringify(CLEAN_RESPONSE)));
    render(<GeoAnomaliesSection playerId="p-1" />);

    expect(await screen.findByText('Аномалий не обнаружено')).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Карта локаций игрока' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Хронология смен/)).not.toBeInTheDocument();
  });

  it('flags multi-country history and a recent country switch', async () => {
    stubFetch(() => new Response(JSON.stringify(SWITCH_RESPONSE)));
    render(<GeoAnomaliesSection playerId="p-1" />);

    expect(await screen.findByText('Мульти-страна (3)')).toBeInTheDocument();
    expect(screen.getByText('Смена страны менее чем за 6 ч')).toBeInTheDocument();
    expect(screen.queryByText('Аномалий не обнаружено')).not.toBeInTheDocument();
    expect(
      screen.getByText('Смена страны за менее чем 6 ч помечена как алерт.'),
    ).toBeInTheDocument();
  });

  it('lists switches newest first and marks only the in-window one as an alert', async () => {
    stubFetch(() => new Response(JSON.stringify(SWITCH_RESPONSE)));
    render(<GeoAnomaliesSection playerId="p-1" />);

    expect(await screen.findByText('Хронология смен (2)')).toBeInTheDocument();
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0] as HTMLElement).getByText('США')).toBeInTheDocument();
    expect(within(rows[0] as HTMLElement).getByText('Δ 3 дн')).toBeInTheDocument();
    expect(within(rows[0] as HTMLElement).queryByText('Алерт')).not.toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText('Германия')).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText('Δ 2 ч')).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText('Алерт')).toBeInTheDocument();
  });

  it('falls back to the country code when the name is unknown and shows minutes for short gaps', async () => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify({
            ...SWITCH_RESPONSE,
            switches: [
              {
                from_country_code: 'FR',
                from_country_name: null,
                to_country_code: 'ES',
                to_country_name: null,
                to_observed_at: '2026-03-01T10:00:00.000Z',
                gap_hours: 0.5,
                within_window: false,
              },
            ],
          }),
        ),
    );
    render(<GeoAnomaliesSection playerId="p-1" />);

    expect(await screen.findByText('FR')).toBeInTheDocument();
    expect(screen.getByText('ES')).toBeInTheDocument();
    expect(screen.getByText('Δ 30 мин')).toBeInTheDocument();
  });

  it('draws one marker per location and a trail between them', async () => {
    stubFetch(() => new Response(JSON.stringify(SWITCH_RESPONSE)));
    render(<GeoAnomaliesSection playerId="p-1" />);

    const map = await screen.findByRole('img', { name: 'Карта локаций игрока' });
    expect(map.querySelectorAll('circle')).toHaveLength(2);
    expect(map.querySelectorAll('polyline')).toHaveLength(1);
  });

  it('shows the HTTP status on failure and reloads on retry', async () => {
    let attempt = 0;
    const fetchMock = stubFetch(() => {
      attempt += 1;
      return attempt === 1
        ? new Response('{}', { status: 500 })
        : new Response(JSON.stringify(CLEAN_RESPONSE));
    });
    render(<GeoAnomaliesSection playerId="p-1" />);

    expect(await screen.findByText('Не удалось загрузить гео-аномалии')).toBeInTheDocument();
    expect(screen.getByText('HTTP 500')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Повторить' }));

    expect(await screen.findByText('Аномалий не обнаружено')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
