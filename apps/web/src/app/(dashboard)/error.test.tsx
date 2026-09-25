// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DashboardError from './error';

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('граница ошибки раздела', () => {
  it('объявляет сбой и предлагает повторить', () => {
    const reset = vi.fn();
    render(<DashboardError error={new Error('boom')} reset={reset} />);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Раздел не открылся');
    expect(screen.getByRole('alert')).toHaveTextContent('не смогла загрузить');

    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('показывает идентификатор записи, когда Next.js его дал', () => {
    const error = Object.assign(new Error('boom'), { digest: 'a1b2c3' });
    render(<DashboardError error={error} reset={vi.fn()} />);
    expect(screen.getByText('a1b2c3')).toBeInTheDocument();
  });

  it('не выдумывает идентификатор, когда его нет', () => {
    render(<DashboardError error={new Error('boom')} reset={vi.fn()} />);
    expect(screen.queryByText(/^[0-9a-f]{6}$/)).not.toBeInTheDocument();
  });
});
