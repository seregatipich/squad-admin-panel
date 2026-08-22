// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { StatusBadge, StatusDot, type StatusState } from './StatusBadge';

const STATES: StatusState[] = ['good', 'warn', 'crit', 'idle'];

/**
 * Оформительский узел индикатора — точка или заменивший её значок. Ищется по
 * `aria-hidden`: это единственная часть без доступного имени. Бросает, а не
 * возвращает `null`, иначе следующий ассерт молча пройдёт на пустом значении.
 */
function decorationOf(container: HTMLElement): HTMLElement {
  const node = container.querySelector<HTMLElement>('[aria-hidden="true"]');
  if (node === null) throw new Error('индикатор состояния не отрендерен');
  return node;
}

function rootOf(container: HTMLElement): HTMLElement {
  const root = container.firstElementChild;
  if (!(root instanceof HTMLElement)) throw new Error('компонент ничего не отрендерил');
  return root;
}

afterEach(cleanup);

describe('StatusDot', () => {
  it.each(STATES)('рендерит подпись и точку для состояния %s', (state) => {
    const { container } = render(<StatusDot state={state} label={`состояние ${state}`} />);
    expect(screen.getByText(`состояние ${state}`)).toBeVisible();
    expect(decorationOf(container)).toBeInTheDocument();
  });

  it('оставляет подпись в разметке даже когда она скрыта с экрана', () => {
    render(<StatusDot state="good" label="Онлайн" hideLabel />);
    // Класс проверяется намеренно: `sr-only` — это контракт доступности
    // (подпись читается, но не видна), а не оформление.
    expect(screen.getByText('Онлайн')).toHaveClass('sr-only');
  });

  it('сохраняет доступное имя при скрытой подписи и дублирует её подсказкой', () => {
    const { container } = render(<StatusDot state="crit" label="Сервер упал" hideLabel />);
    expect(rootOf(container)).toHaveAccessibleName('Сервер упал');
    expect(screen.getByTitle('Сервер упал')).toBeInTheDocument();
  });

  it('не подменяет видимую подпись подсказкой без hideLabel', () => {
    render(<StatusDot state="good" label="Онлайн" />);
    expect(screen.queryByTitle('Онлайн')).not.toBeInTheDocument();
  });

  it('прячет точку от программ чтения с экрана: её смысл уже в подписи', () => {
    const { container } = render(<StatusDot state="warn" label="Задержка" />);
    expect(decorationOf(container)).toHaveAttribute('aria-hidden', 'true');
  });

  it('анимирует точку только по запросу — пульсация занята «данные идут сейчас»', () => {
    const { container: pulsing } = render(<StatusDot state="good" label="Онлайн" pulse />);
    expect(decorationOf(pulsing)).toHaveClass('animate-pulse');

    const { container: still } = render(<StatusDot state="good" label="Онлайн" />);
    expect(decorationOf(still)).not.toHaveClass('animate-pulse');
  });
});

describe('StatusBadge', () => {
  it.each(STATES)('рендерит подпись для состояния %s', (state) => {
    render(<StatusBadge state={state} label={`состояние ${state}`} />);
    expect(screen.getByText(`состояние ${state}`)).toBeVisible();
  });

  it('показывает точку, когда значок не передан', () => {
    const { container } = render(<StatusBadge state="good" label="Работает" />);
    expect(decorationOf(container)).toBeInTheDocument();
  });

  it('заменяет точку значком и прячет его от программ чтения с экрана', () => {
    const { container } = render(<StatusBadge state="crit" label="Упал" icon={<span>✕</span>} />);
    const decoration = decorationOf(container);
    expect(decoration).toHaveAttribute('aria-hidden', 'true');
    expect(decoration).toHaveTextContent('✕');
    expect(screen.getByText('Упал')).toBeVisible();
  });

  it('анимирует точку только по запросу', () => {
    const { container: pulsing } = render(<StatusBadge state="good" label="Идут данные" pulse />);
    expect(decorationOf(pulsing)).toHaveClass('animate-pulse');

    const { container: still } = render(<StatusBadge state="good" label="Работает" />);
    expect(decorationOf(still)).not.toHaveClass('animate-pulse');
  });
});
