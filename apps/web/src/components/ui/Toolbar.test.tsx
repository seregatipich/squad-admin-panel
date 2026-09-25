// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Toolbar } from './Toolbar';

afterEach(cleanup);

describe('Toolbar', () => {
  it('renders every slot it is given', () => {
    render(
      <Toolbar
        search={<input type="search" aria-label="Поиск" />}
        filters={<button type="button">Роль</button>}
        summary="найдено 128"
        actions={<button type="button">Экспорт</button>}
      />,
    );

    expect(screen.getByRole('searchbox', { name: 'Поиск' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Роль' })).toBeInTheDocument();
    expect(screen.getByText('найдено 128')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Экспорт' })).toBeInTheDocument();
  });

  it('hides the reset button until an onReset handler is given', () => {
    render(<Toolbar filters={<button type="button">Роль</button>} />);
    expect(screen.queryByRole('button', { name: 'Сбросить фильтры' })).not.toBeInTheDocument();
  });

  it('shows the reset button with onReset and reports the click', () => {
    const onReset = vi.fn();
    render(<Toolbar onReset={onReset} resetLabel="Сбросить фильтры" />);

    const reset = screen.getByRole('button', { name: 'Сбросить фильтры' });
    fireEvent.click(reset);
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it('keeps the tab order fixed: search, filters, reset, actions', () => {
    const { container } = render(
      <Toolbar
        search={<input type="search" aria-label="Поиск" />}
        filters={<button type="button">Роль</button>}
        summary="найдено 128"
        actions={<button type="button">Экспорт</button>}
        onReset={vi.fn()}
        resetLabel="Сбросить"
      />,
    );

    // Порядок обхода с клавиатуры — то же обещание, что и порядок на экране:
    // оператор находит элемент управления там, где нашёл его в прошлый раз.
    const order = Array.from(container.querySelectorAll('input, button')).map(
      (element) => element.getAttribute('aria-label') ?? element.textContent,
    );
    expect(order).toEqual(['Поиск', 'Роль', 'Сбросить', 'Экспорт']);
  });

  it('renders nothing but the flexible search cell when no slot is filled', () => {
    render(<Toolbar />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
