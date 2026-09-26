// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { MarkTypeMini } from '@/lib/marks';
import { PlayerMarkBadge } from './PlayerMarkBadge';

afterEach(cleanup);

function mark(overrides: Partial<MarkTypeMini> = {}): MarkTypeMini {
  return {
    mark_type_id: 1,
    slug: 'watch',
    label_en: 'Watch',
    label_ru: 'Наблюдение',
    icon: 'scan-eye',
    severity: 1,
    ...overrides,
  };
}

describe('PlayerMarkBadge', () => {
  it('renders nothing when the player has no marks', () => {
    const { container } = render(<PlayerMarkBadge marks={[]} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('uses the highest-severity mark without changing the caller order', () => {
    const marks = [
      mark(),
      mark({
        mark_type_id: 2,
        slug: 'danger',
        label_en: 'Danger',
        label_ru: 'Опасность',
        icon: 'skull',
        severity: 5,
      }),
    ];
    const originalOrder = marks.map((item) => item.slug);

    render(<PlayerMarkBadge marks={marks} />);

    // Значок самой тяжёлой метки и перечень подписей в подсказке — это и есть
    // наблюдаемое поведение; тон пилюли задаёт примитив `Badge`.
    expect(screen.getByText('💀')).toBeInTheDocument();
    expect(screen.getByText('метка ×2')).toBeInTheDocument();
    expect(screen.getByTitle('Наблюдение, Опасность')).toBeInTheDocument();
    expect(marks.map((item) => item.slug)).toEqual(originalOrder);
  });

  it('renders the singular label and fallback icon for an unknown icon', () => {
    render(<PlayerMarkBadge marks={[mark({ icon: 'future-icon' })]} />);

    expect(screen.getByText('🚩')).toBeInTheDocument();
    expect(screen.getByText('метка')).toBeInTheDocument();
    expect(screen.queryByText('метка ×1')).not.toBeInTheDocument();
    expect(screen.getByTitle('Наблюдение')).toBeInTheDocument();
  });
});
