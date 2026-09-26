// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmptyState } from './EmptyState';

afterEach(cleanup);

describe('EmptyState', () => {
  it('shows the title and the explanation', () => {
    render(<EmptyState title="Серверов нет" description="Добавьте первый сервер." />);
    expect(screen.getByText('Серверов нет')).toBeInTheDocument();
    expect(screen.getByText('Добавьте первый сервер.')).toBeInTheDocument();
  });

  it('renders the action and keeps it clickable', () => {
    const onClick = vi.fn();
    render(
      <EmptyState
        title="Серверов нет"
        action={
          <button type="button" onClick={onClick}>
            Добавить сервер
          </button>
        }
      />,
    );

    const action = screen.getByRole('button', { name: 'Добавить сервер' });
    fireEvent.click(action);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('omits the description and the action when they are not given', () => {
    render(<EmptyState title="Серверов нет" />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('Серверов нет')).toBeInTheDocument();
  });

  it('distinguishes the filtered variant from the initial one', () => {
    const { container: initial } = render(<EmptyState title="Серверов нет" />);
    expect(initial.querySelector('[data-variant="initial"]')).not.toBeNull();

    const { container: filtered } = render(
      <EmptyState
        title="Ничего не нашлось"
        variant="filtered"
        action={<button type="button">Сбросить фильтры</button>}
      />,
    );
    expect(filtered.querySelector('[data-variant="filtered"]')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Сбросить фильтры' })).toBeInTheDocument();
  });

  it('hides the decorative icon from assistive technology', () => {
    const { container } = render(
      <EmptyState title="Серверов нет" icon={<span data-testid="icon">◻</span>} />,
    );
    expect(container.querySelector('[aria-hidden="true"]')).toContainElement(
      screen.getByTestId('icon'),
    );
  });
});
