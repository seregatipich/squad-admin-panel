/**
 * Цвета для графиков.
 *
 * Графики рисуются в SVG и через recharts, а обе эти среды принимают только
 * готовое значение цвета — `var(--color-*)` в атрибут `stroke` recharts не
 * пробрасывает. Поэтому значения продублированы здесь как константы, и это
 * единственное место в приложении, где такое дублирование допустимо: без него
 * шестнадцатеричные литералы расползаются по компонентам графиков и начинают
 * расходиться с темой (так уже случилось с рамкой подсказки `#333`, которой
 * нет ни в одном токене).
 *
 * Значения обязаны совпадать с `src/styles/globals.css`; проверяется тестом.
 */

/** Оси, сетка и подписи — нейтральный слой под данными. */
export const CHART_AXIS = '#a1a1a8';
export const CHART_GRID = '#38383a';
export const CHART_FRAME = '#48484a';
export const CHART_SURFACE = '#2c2c2e';
export const CHART_BORDER = '#38383a';

/**
 * Серии по смыслу метрики.
 *
 * Цвет здесь категориальный, а не оценочный: зелёная линия CPU не значит
 * «всё хорошо», она значит «это CPU». Оценку даёт порог на шкале, а не оттенок.
 */
export const CHART_SERIES = {
  cpu: '#30d158',
  ram: '#409cff',
  disk: '#bf5af2',
  rx: '#409cff',
  tx: '#ff9f0a',
} as const;

export type ChartSeriesKey = keyof typeof CHART_SERIES;

/** Заливка области под линией: данные читаются, фон не спорит с сеткой. */
export const CHART_AREA_OPACITY = 0.2;

/** Оформление всплывающей подсказки recharts. */
export const CHART_TOOLTIP_STYLE = {
  background: CHART_SURFACE,
  border: `1px solid ${CHART_BORDER}`,
  borderRadius: '10px',
  fontSize: '12px',
} as const;
