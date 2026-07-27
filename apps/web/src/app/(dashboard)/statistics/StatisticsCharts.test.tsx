// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const barProps: Array<Record<string, unknown>> = [];

// recharts needs a real layout to render; the charts under test only own the
// prop wiring (stack ids, colours, drill-down handler), so the primitives are
// replaced with prop-recording stubs.
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  BarChart: ({ children }: { children: ReactNode }) => (
    <div data-testid="bar-chart">{children}</div>
  ),
  Bar: (props: Record<string, unknown>) => {
    barProps.push(props);
    return <div data-testid="bar" />;
  },
  CartesianGrid: () => <div />,
  XAxis: () => <div />,
  YAxis: () => <div />,
  Tooltip: () => <div />,
  Legend: () => <div />,
  PieChart: ({ children }: { children: ReactNode }) => (
    <div data-testid="pie-chart">{children}</div>
  ),
  Pie: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Cell: () => <div data-testid="cell" />,
}));

import type { StatisticsSeries } from './helpers';
import { ModesDoughnut, StackedSeriesChart } from './StatisticsCharts';

const SERVER_A = '019e0000-0000-7000-8000-0000000000a1';
const SERVER_B = '019e0000-0000-7000-8000-0000000000b2';

const SERVERS = [
  { server_id: SERVER_A, display_name: 'Main' },
  { server_id: SERVER_B, display_name: 'Second' },
];

const SERIES: StatisticsSeries = {
  by_server: [
    { server_id: SERVER_A, points: [{ key: '2026-07-01', value: 10 }] },
    { server_id: SERVER_B, points: [{ key: '2026-07-01', value: 5 }] },
  ],
  totals: [{ key: '2026-07-01', value: 15 }],
  kpi: { avg: 15, max: 15, total: 15 },
};

afterEach(() => {
  cleanup();
  barProps.length = 0;
});

describe('StackedSeriesChart', () => {
  it('emits one stacked bar per server, each on the shared stack', () => {
    render(
      <StackedSeriesChart
        series={SERIES}
        servers={SERVERS}
        knownServerIds={[SERVER_A, SERVER_B]}
        labelOf={(key) => key}
      />,
    );
    expect(barProps).toHaveLength(2);
    for (const props of barProps) expect(props.stackId).toBe('all');
    expect(barProps.map((p) => p.dataKey)).toEqual([SERVER_A, SERVER_B]);
  });

  it('gives each server a distinct colour', () => {
    render(
      <StackedSeriesChart
        series={SERIES}
        servers={SERVERS}
        knownServerIds={[SERVER_A, SERVER_B]}
        labelOf={(key) => key}
      />,
    );
    expect(new Set(barProps.map((p) => p.fill)).size).toBe(2);
  });

  it('reports the clicked server and bucket key through onDrill', () => {
    const onDrill = vi.fn();
    render(
      <StackedSeriesChart
        series={SERIES}
        servers={SERVERS}
        knownServerIds={[SERVER_A, SERVER_B]}
        labelOf={(key) => key}
        onDrill={onDrill}
      />,
    );
    const handler = barProps[0]?.onClick as (entry: unknown) => void;
    handler({ payload: { key: '2026-07-01' } });
    expect(onDrill).toHaveBeenCalledWith(SERVER_A, '2026-07-01');
  });

  it('ignores a click carrying no bucket key', () => {
    const onDrill = vi.fn();
    render(
      <StackedSeriesChart
        series={SERIES}
        servers={SERVERS}
        knownServerIds={[SERVER_A, SERVER_B]}
        labelOf={(key) => key}
        onDrill={onDrill}
      />,
    );
    const handler = barProps[0]?.onClick as (entry: unknown) => void;
    handler({});
    handler(undefined);
    expect(onDrill).not.toHaveBeenCalled();
  });

  it('is inert and uncursored without an onDrill handler', () => {
    render(
      <StackedSeriesChart
        series={SERIES}
        servers={SERVERS}
        knownServerIds={[SERVER_A, SERVER_B]}
        labelOf={(key) => key}
      />,
    );
    expect(barProps[0]?.cursor).toBeUndefined();
    const handler = barProps[0]?.onClick as (entry: unknown) => void;
    expect(() => handler({ payload: { key: '2026-07-01' } })).not.toThrow();
  });
});

describe('ModesDoughnut', () => {
  it('renders one coloured cell per game mode', () => {
    const { getAllByTestId } = render(
      <ModesDoughnut
        modes={[
          { mode: 'AAS', matches: 8 },
          { mode: 'RAAS', matches: 5 },
        ]}
      />,
    );
    expect(getAllByTestId('cell')).toHaveLength(2);
  });

  it('renders without cells when there is no mode data', () => {
    const { queryAllByTestId, getByTestId } = render(<ModesDoughnut modes={[]} />);
    expect(getByTestId('pie-chart')).toBeInTheDocument();
    expect(queryAllByTestId('cell')).toHaveLength(0);
  });
});
