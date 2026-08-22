// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Badge, type BadgeTone } from './Badge';

const TONES: BadgeTone[] = ['neutral', 'accent', 'good', 'warn', 'crit'];

afterEach(cleanup);

describe('Badge', () => {
  it('показывает содержимое как обычный текст', () => {
    render(<Badge>Модератор</Badge>);
    expect(screen.getByText('Модератор')).toBeInTheDocument();
  });

  it.each(TONES)('оставляет текст доступным при тоне %s', (tone) => {
    render(<Badge tone={tone}>Состояние</Badge>);
    const label = screen.getByText('Состояние');
    expect(label).toBeInTheDocument();
    expect(label).toBeVisible();
  });

  it.each(['sm', 'md'] as const)('рендерит содержимое при размере %s', (size) => {
    render(<Badge size={size}>42</Badge>);
    expect(screen.getByText('42')).toBeVisible();
  });

  it('раскрывает сокращение подсказкой, когда она передана', () => {
    render(<Badge title="Заблокирован навсегда">перм</Badge>);
    expect(screen.getByTitle('Заблокирован навсегда')).toHaveTextContent('перм');
  });

  it('не выдумывает подсказку, когда её не передали', () => {
    render(<Badge>перм</Badge>);
    expect(screen.getByText('перм')).not.toHaveAttribute('title');
  });

  it('пропускает вложенные узлы, а не только строки', () => {
    render(
      <Badge tone="accent">
        <span aria-hidden="true">●</span>
        <span>Онлайн</span>
      </Badge>,
    );
    expect(screen.getByText('Онлайн')).toBeInTheDocument();
  });
});
