// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import NotFound from './not-found';

afterEach(cleanup);

describe('экран несуществующего адреса', () => {
  it('объясняет, что произошло, и даёт путь назад', () => {
    render(<NotFound />);
    expect(screen.getByText('Страница не найдена')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'На дашборд' })).toHaveAttribute('href', '/dashboard');
  });
});
