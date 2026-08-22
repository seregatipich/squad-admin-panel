// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
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
});
