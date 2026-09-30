// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
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

describe('live region timing (#817)', () => {
  /**
   * NVDA and JAWS skip a polite region that enters the DOM already holding its
   * text and announce only a change to a region that is already there, so the
   * region must be rendered empty and filled afterwards.
   */
  it('renders the Skeleton status region empty and fills it after mount', () => {
    const html = renderToString(<Skeleton variant="row" label="Загружаем игроков" />);
    expect(html).toContain('role="status"');
    expect(html).not.toContain('Загружаем игроков');

    render(<Skeleton variant="row" label="Загружаем игроков" />);
    expect(screen.getByRole('status')).toHaveTextContent('Загружаем игроков');
  });

  it('renders the SkeletonTable status region empty and fills it after mount', () => {
    const html = renderToString(<SkeletonTable rows={1} cols={1} label="Загружаем таблицу" />);
    expect(html).toContain('role="status"');
    expect(html).not.toContain('Загружаем таблицу');

    render(<SkeletonTable rows={1} cols={1} label="Загружаем таблицу" />);
    expect(screen.getByRole('status')).toHaveTextContent('Загружаем таблицу');
  });

  it('updates the announcement when the label changes', () => {
    const { rerender } = render(<Skeleton variant="row" label="Загружаем игроков" />);
    rerender(<Skeleton variant="row" label="Загружаем серверы" />);
    expect(screen.getByRole('status')).toHaveTextContent('Загружаем серверы');
  });
});
