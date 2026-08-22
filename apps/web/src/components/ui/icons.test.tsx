// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import * as icons from './icons';

const ALL = Object.entries(icons).filter(([name]) => name.endsWith('Icon'));

afterEach(cleanup);

describe('набор значков', () => {
  it('экспортирует только компоненты-значки', () => {
    expect(ALL.length).toBeGreaterThan(15);
    for (const [, Component] of ALL) {
      expect(typeof Component).toBe('function');
    }
  });

  it.each(ALL)('%s декоративен и наследует цвет текста', (_name, Component) => {
    const { container } = render(<Component />);
    const svg = container.querySelector('svg');

    // Значок всегда сопровождается подписью или aria-label кнопки, поэтому сам
    // он не должен попадать в дерево доступности.
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).toHaveAttribute('stroke', 'currentColor');
    expect(svg).toHaveAttribute('viewBox', '0 0 16 16');
    expect(svg?.querySelector('path, circle, rect')).not.toBeNull();
  });

  it('принимает размер через className, сохраняя защиту от сжатия', () => {
    const { container } = render(<icons.SearchIcon className="size-5" />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveClass('size-5');
    expect(svg).toHaveClass('shrink-0');
  });
});
