// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StatTile } from './StatTile';

afterEach(cleanup);

describe('StatTile', () => {
  it('renders the label, the value and the hint', () => {
    render(<StatTile label="ОНЛАЙН" value={42} hint="из 100 слотов" />);
    expect(screen.getByText('ОНЛАЙН')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('из 100 слотов')).toBeInTheDocument();
  });

  it('stays a plain surface without onClick', () => {
    render(<StatTile label="ОНЛАЙН" value={42} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders the value at both sizes', () => {
    render(<StatTile label="ОНЛАЙН" value={42} size="sm" />);
    expect(screen.getByText('42')).toBeInTheDocument();
  });

  it('exposes the whole tile as a button named by actionLabel', async () => {
    const onClick = vi.fn();
    render(
      <StatTile
        label="ОНЛАЙН"
        value={42}
        onClick={onClick}
        actionLabel="Онлайн, 42 игрока — открыть список"
      />,
    );

    const button = screen.getByRole('button', { name: 'Онлайн, 42 игрока — открыть список' });
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('reacts to the keyboard because it is a real button', async () => {
    const onClick = vi.fn();
    render(<StatTile label="ОНЛАЙН" value={42} onClick={onClick} actionLabel="Открыть список" />);

    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Открыть список' })).toHaveFocus();

    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard(' ');
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it('announces a single progress bar with its value and the tile label', () => {
    render(<StatTile label="ЗАПОЛНЕНИЕ" value="64 / 100" tone="warn" progress={{ pct: 64 }} />);

    const bar = screen.getByRole('progressbar', { name: 'ЗАПОЛНЕНИЕ' });
    expect(bar).toHaveAttribute('aria-valuenow', '64');
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
  });

  it('clamps an out-of-range percentage instead of overflowing the bar', () => {
    const { rerender } = render(<StatTile label="CPU" value="—" progress={{ pct: 150 }} />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');

    rerender(<StatTile label="CPU" value="—" progress={{ pct: -20 }} />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');

    rerender(<StatTile label="CPU" value="—" progress={{ pct: Number.NaN }} />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
  });

  it('spells every segment out in a legend, so no share is colour-only', () => {
    render(
      <StatTile
        label="СЛОТЫ"
        value="100"
        progress={{
          segments: [
            { pct: 60, tone: 'good', label: 'Играют' },
            { pct: 25, tone: 'warn', label: 'В очереди' },
            { pct: 15, tone: 'neutral', label: 'Свободно' },
          ],
        }}
      />,
    );

    for (const { label, pct } of [
      { label: 'Играют', pct: '60%' },
      { label: 'В очереди', pct: '25%' },
      { label: 'Свободно', pct: '15%' },
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
      expect(screen.getByText(pct)).toBeInTheDocument();
    }
  });

  it('keeps the segmented bar itself out of the accessibility tree', () => {
    render(
      <StatTile
        label="СЛОТЫ"
        value="100"
        progress={{ segments: [{ pct: 100, tone: 'good', label: 'Играют' }] }}
      />,
    );
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('carries a progress bar inside the clickable variant', () => {
    render(
      <StatTile
        label="ЗАПОЛНЕНИЕ"
        value="64 / 100"
        progress={{ pct: 64 }}
        onClick={() => {}}
        actionLabel="Заполнение 64 из 100 — открыть сервер"
      />,
    );
    expect(
      screen.getByRole('button', { name: 'Заполнение 64 из 100 — открыть сервер' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '64');
  });
});
