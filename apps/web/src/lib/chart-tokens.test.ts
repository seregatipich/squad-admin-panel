import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CHART_AXIS,
  CHART_BORDER,
  CHART_FRAME,
  CHART_GRID,
  CHART_SERIES,
  CHART_SURFACE,
  CHART_TOOLTIP_STYLE,
} from './chart-tokens';

const globalsCss = readFileSync(
  fileURLToPath(new URL('../styles/globals.css', import.meta.url)),
  'utf8',
);

/** Значение токена темы по его имени, как оно записано в globals.css. */
function token(name: string): string {
  const match = globalsCss.match(new RegExp(`--color-${name}:\\s*(#[0-9a-f]{6})`, 'i'));
  if (!match) throw new Error(`токен --color-${name} не найден в globals.css`);
  return match[1].toLowerCase();
}

describe('палитра графиков', () => {
  // Дублирование значений неизбежно (recharts не принимает var()), поэтому
  // расхождение с темой должно ловиться тестом, а не глазом на проде.
  it.each([
    ['CHART_AXIS', CHART_AXIS, 'neutral-500'],
    ['CHART_GRID', CHART_GRID, 'line'],
    ['CHART_FRAME', CHART_FRAME, 'line-2'],
    ['CHART_SURFACE', CHART_SURFACE, 'surface'],
    ['CHART_BORDER', CHART_BORDER, 'line'],
  ])('%s совпадает с токеном темы', (_name, value, tokenName) => {
    expect(value.toLowerCase()).toBe(token(tokenName));
  });

  it.each([
    ['cpu', CHART_SERIES.cpu, 'good'],
    ['ram', CHART_SERIES.ram, 'accent'],
    ['rx', CHART_SERIES.rx, 'accent'],
    ['tx', CHART_SERIES.tx, 'warn'],
  ])('серия %s взята из палитры состояний', (_key, value, tokenName) => {
    expect(value.toLowerCase()).toBe(token(tokenName));
  });

  it('подсказка не изобретает собственную рамку', () => {
    expect(CHART_TOOLTIP_STYLE.border).toBe(`1px solid ${CHART_BORDER}`);
    expect(CHART_TOOLTIP_STYLE.background).toBe(CHART_SURFACE);
  });
});
