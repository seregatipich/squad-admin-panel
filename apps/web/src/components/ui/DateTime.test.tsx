// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DateTime,
  formatAbsolute,
  formatClock,
  formatRelative,
  type RelativeLabels,
} from './DateTime';

afterEach(cleanup);

// Собран из локальных компонент, а не из ISO-строки с зоной: тогда ожидаемая
// строка одинакова в любом часовом поясе, где запускается набор.
const MOMENT = new Date(2026, 7, 22, 15, 23, 45);
const MOMENT_TEXT = '22.08.2026, 15:23:45';

const LABELS: RelativeLabels = {
  justNow: 'только что',
  secondsAgo: (n) => `сек:${n}`,
  minutesAgo: (n) => `мин:${n}`,
  hoursAgo: (n) => `ч:${n}`,
  daysAgo: (n) => `дн:${n}`,
};

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

function ago(ms: number): number {
  return MOMENT.getTime() + ms;
}

function timeElement(container: HTMLElement): HTMLTimeElement {
  const element = container.querySelector('time');
  if (element === null) throw new Error('<time> не отрисован');
  return element;
}

describe('formatAbsolute', () => {
  it('formats a fixed moment identically for a Date, an epoch number and a local ISO string', () => {
    expect(formatAbsolute(MOMENT, 'ru')).toBe(MOMENT_TEXT);
    expect(formatAbsolute(MOMENT.getTime(), 'ru')).toBe(MOMENT_TEXT);
    expect(formatAbsolute('2026-08-22T15:23:45', 'ru')).toBe(MOMENT_TEXT);
  });

  it('pads single-digit fields and prints midnight as 00, never 24', () => {
    expect(formatAbsolute(new Date(2026, 0, 5, 0, 5, 9), 'ru')).toBe('05.01.2026, 00:05:09');
  });

  it('keeps a 24-hour clock and seconds under another locale', () => {
    expect(formatAbsolute(MOMENT, 'en-US')).toBe('08/22/2026, 15:23:45');
  });

  it('returns null for an unparsable value', () => {
    expect(formatAbsolute('не дата', 'ru')).toBeNull();
    expect(formatAbsolute(Number.NaN, 'ru')).toBeNull();
    expect(formatAbsolute(new Date('нет'), 'ru')).toBeNull();
  });
});

describe('formatClock', () => {
  it('prints only the time of day, in the same 24-hour clock as the full format', () => {
    expect(formatClock(MOMENT, 'ru')).toBe('15:23:45');
    expect(formatClock(MOMENT, 'en-US')).toBe('15:23:45');
  });

  it('prints midnight as 00, never 24 or 12 AM', () => {
    expect(formatClock(new Date(2026, 0, 5, 0, 5, 9), 'ru')).toBe('00:05:09');
    expect(formatClock(new Date(2026, 0, 5, 0, 5, 9), 'en-US')).toBe('00:05:09');
  });

  it('returns null for an unparsable value', () => {
    expect(formatClock('не дата', 'ru')).toBeNull();
    expect(formatClock(Number.NaN, 'ru')).toBeNull();
  });
});

describe('formatRelative', () => {
  it('says «just now» under 10 seconds and switches to seconds at 10', () => {
    expect(formatRelative(MOMENT, ago(0), LABELS)).toBe('только что');
    expect(formatRelative(MOMENT, ago(9 * SECOND), LABELS)).toBe('только что');
    expect(formatRelative(MOMENT, ago(10 * SECOND), LABELS)).toBe('сек:10');
  });

  it('switches from seconds to minutes at 60 seconds', () => {
    expect(formatRelative(MOMENT, ago(59 * SECOND), LABELS)).toBe('сек:59');
    expect(formatRelative(MOMENT, ago(60 * SECOND), LABELS)).toBe('мин:1');
  });

  it('switches from minutes to hours at 60 minutes', () => {
    expect(formatRelative(MOMENT, ago(59 * MINUTE), LABELS)).toBe('мин:59');
    expect(formatRelative(MOMENT, ago(60 * MINUTE), LABELS)).toBe('ч:1');
  });

  it('switches from hours to days at 24 hours', () => {
    expect(formatRelative(MOMENT, ago(23 * HOUR), LABELS)).toBe('ч:23');
    expect(formatRelative(MOMENT, ago(24 * HOUR), LABELS)).toBe('дн:1');
    expect(formatRelative(MOMENT, ago(72 * HOUR), LABELS)).toBe('дн:3');
  });

  it('treats a moment in the future as «just now» rather than negative time', () => {
    expect(formatRelative(MOMENT, ago(-5 * MINUTE), LABELS)).toBe('только что');
  });

  it('returns null for an unparsable value', () => {
    expect(formatRelative('не дата', ago(0), LABELS)).toBeNull();
  });
});

describe('DateTime', () => {
  it('renders a <time> carrying the machine-readable instant and the absolute title', () => {
    const { container } = render(<DateTime value={MOMENT} locale="ru" />);
    const element = timeElement(container);

    expect(element).toHaveAttribute('dateTime', MOMENT.toISOString());
    expect(element).toHaveAttribute('title', MOMENT_TEXT);
    expect(element).toHaveTextContent(MOMENT_TEXT);
  });

  it('shows only the relative text in relative mode, keeping the absolute in the title', () => {
    const { container } = render(
      <DateTime
        value={MOMENT}
        locale="ru"
        mode="relative"
        relativeLabels={LABELS}
        now={ago(5 * MINUTE)}
      />,
    );
    const element = timeElement(container);

    expect(element).toHaveTextContent('мин:5');
    expect(element).not.toHaveTextContent(MOMENT_TEXT);
    expect(element).toHaveAttribute('title', MOMENT_TEXT);
  });

  it('shows both readings side by side in both mode', () => {
    const { container } = render(
      <DateTime
        value={MOMENT}
        locale="ru"
        mode="both"
        relativeLabels={LABELS}
        now={ago(2 * HOUR)}
      />,
    );
    const element = timeElement(container);

    expect(element).toHaveTextContent('ч:2');
    expect(element).toHaveTextContent(MOMENT_TEXT);
    // Разделены настоящим пробелом, а не отступом: иначе скопированная строка
    // и синтезированная речь слипаются в «ч:222.08.2026».
    expect(element.textContent).toBe(`ч:2 ${MOMENT_TEXT}`);
  });

  it('falls back to Date.now() when no reference point is given', () => {
    vi.useFakeTimers();
    vi.setSystemTime(ago(3 * HOUR));
    const { container } = render(
      <DateTime value={MOMENT} locale="ru" mode="relative" relativeLabels={LABELS} />,
    );
    expect(timeElement(container)).toHaveTextContent('ч:3');
    vi.useRealTimers();
  });

  it('renders the fallback and no <time> element for an invalid date', () => {
    const { container, rerender } = render(<DateTime value="не дата" locale="ru" />);
    expect(container.querySelector('time')).toBeNull();
    expect(container).toHaveTextContent('—');

    rerender(<DateTime value="не дата" locale="ru" fallback="нет данных" />);
    expect(container).toHaveTextContent('нет данных');
  });
});
