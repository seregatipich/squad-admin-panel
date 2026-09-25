// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Skeleton, SkeletonTable } from './Skeleton';

afterEach(cleanup);

/** Плашки — единственные `aria-hidden` узлы в этих компонентах. */
function plaques(container: HTMLElement): NodeListOf<Element> {
  return container.querySelectorAll('[aria-hidden="true"]');
}

describe('Skeleton', () => {
  it('announces nothing without a label', () => {
    const { container } = render(<Skeleton variant="text" />);
    expect(screen.queryByRole('status')).toBeNull();
    expect(plaques(container)).toHaveLength(1);
  });

  it('announces the loading state through role="status" when a label is given', () => {
    render(<Skeleton variant="row" label="Загружаем игроков" />);
    expect(screen.getByRole('status')).toHaveTextContent('Загружаем игроков');
  });

  it('hides every plaque from assistive technology', () => {
    const { container } = render(<Skeleton variant="text" count={3} label="Загрузка" />);
    const hidden = plaques(container);
    expect(hidden).toHaveLength(3);
    for (const plaque of hidden) {
      expect(plaque).toHaveAttribute('aria-hidden', 'true');
    }
  });

  it('renders the requested number of plaques', () => {
    const { container } = render(<Skeleton variant="card" count={4} />);
    expect(plaques(container)).toHaveLength(4);
  });

  it('applies an arbitrary width as an inline style', () => {
    const { container } = render(<Skeleton variant="text" width="40%" />);
    const plaque = plaques(container)[0] as HTMLElement;
    expect(plaque.style.width).toBe('40%');
  });
});

describe('SkeletonTable', () => {
  it('draws a plaque for every cell of the grid', () => {
    const { container } = render(<SkeletonTable rows={3} cols={4} />);
    expect(plaques(container)).toHaveLength(12);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('announces the loading state when a label is given', () => {
    render(<SkeletonTable rows={2} cols={2} label="Загружаем таблицу" />);
    expect(screen.getByRole('status')).toHaveTextContent('Загружаем таблицу');
  });
});
