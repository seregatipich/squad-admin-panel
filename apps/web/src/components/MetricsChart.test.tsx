// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MetricsChart } from './MetricsChart';

afterEach(cleanup);

const POINTS = [
  { timestamp: '2026-08-22T09:00:00.000Z', value: 10 },
  { timestamp: '2026-08-22T09:01:00.000Z', value: 30 },
  { timestamp: '2026-08-22T09:02:00.000Z', value: 20 },
];

describe('MetricsChart', () => {
  it('exports a React component function', async () => {
    const mod = await import('./MetricsChart');
    expect(typeof mod.MetricsChart).toBe('function');
  });

  it('explains an empty series instead of drawing an empty frame', () => {
    render(<MetricsChart points={[]} label="CPU" unit="%" color="#30d158" />);
    expect(screen.getByText('CPU')).toBeInTheDocument();
    expect(screen.getByText('Нет данных')).toBeInTheDocument();
  });

  it('shows the latest value and an accessible line for the series', () => {
    render(
      <MetricsChart
        points={POINTS}
        label="CPU"
        unit="%"
        color="#30d158"
        formatValue={(v) => v.toFixed(0)}
      />,
    );
    expect(screen.getByText(/20 %/)).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'CPU' })).toBeInTheDocument();
  });

  it('keeps the drawing unstretched so the slope stays honest', () => {
    const { container } = render(
      <MetricsChart points={POINTS} label="RAM" unit="GB" color="#409cff" />,
    );
    const svg = container.querySelector('svg');
    expect(svg).not.toHaveAttribute('preserveAspectRatio', 'none');
  });

  it('keeps the line inside the frame when a value exceeds maxY', () => {
    const points = [
      { timestamp: '2026-08-22T09:00:00.000Z', value: 50 },
      { timestamp: '2026-08-22T09:01:00.000Z', value: 240 },
    ];
    const { container } = render(
      <MetricsChart points={points} label="CPU" unit="%" color="#30d158" maxY={100} />,
    );
    const d = container.querySelector('path')?.getAttribute('d') ?? '';
    const ys = [...d.matchAll(/[ML] [\d.]+ (-?[\d.]+)/g)].map((m) => Number(m[1]));

    expect(ys).toHaveLength(2);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(10);
  });

  it('places points by timestamp so a gap in the series shows as a gap', () => {
    const points = [
      { timestamp: '2026-08-22T09:00:00.000Z', value: 10 },
      { timestamp: '2026-08-22T09:01:00.000Z', value: 10 },
      { timestamp: '2026-08-22T09:10:00.000Z', value: 10 },
    ];
    const { container } = render(
      <MetricsChart points={points} label="CPU" unit="%" color="#fff" />,
    );
    const d = container.querySelector('path')?.getAttribute('d') ?? '';
    const xs = [...d.matchAll(/[ML] (-?[\d.]+) /g)].map((m) => Number(m[1]));

    expect(xs).toHaveLength(3);
    // 1 minute of 10 is a tenth of the width; index spacing would give one half.
    expect((xs[1] - xs[0]) / (xs[2] - xs[0])).toBeCloseTo(0.1, 1);
  });
});
