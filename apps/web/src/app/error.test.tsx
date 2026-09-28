// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RootError from './error';

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('корневая граница ошибки', () => {
  it('сообщает о недоступности API, а не о выходе из сессии, и предлагает повторить', () => {
    const reset = vi.fn();
    render(<RootError error={new Error('API /api/v1/me 503')} reset={reset} />);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Панель недоступна');
    expect(screen.getByRole('alert')).toHaveTextContent('Сессия не сброшена');

    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('показывает идентификатор записи, когда Next.js его дал', () => {
    const error = Object.assign(new Error('boom'), { digest: 'f00d42' });
    render(<RootError error={error} reset={vi.fn()} />);
    expect(screen.getByText('f00d42')).toBeInTheDocument();
  });
});
