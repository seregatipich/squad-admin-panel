// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import DashboardLoading from './loading';

afterEach(cleanup);

describe('экран ожидания раздела', () => {
  it('объявляет загрузку ровно один раз', () => {
    render(<DashboardLoading />);
    // Плашек много, а сообщение о состоянии должно быть одно: иначе скринридер
    // зачитает «загружаем» на каждую полоску каркаса.
    const statuses = screen.getAllByRole('status');
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toHaveTextContent('Загружаем раздел');
  });
});
