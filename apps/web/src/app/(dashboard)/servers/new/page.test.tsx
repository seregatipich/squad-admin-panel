// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/servers/new'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));
vi.mock('@/components/LogConsole', () => ({ LogConsole: () => null }));

import NewServerPage from './page';

afterEach(() => {
  cleanup();
});

describe('NewServerPage', () => {
  it('is a valid React component', () => {
    expect(NewServerPage).toBeDefined();
    expect(typeof NewServerPage).toBe('function');
  });

  it('поля мастера подписаны по-русски и связаны с подписями', () => {
    render(<NewServerPage />);

    const headings = screen.getAllByRole('heading', { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent('Установка нового Squad-сервера');

    expect(screen.getByLabelText(/^Название/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Идентификатор/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Slug/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Установить' })).toHaveAttribute('type', 'submit');
    expect(screen.getByRole('link', { name: 'К списку серверов' })).toHaveAttribute(
      'href',
      '/servers',
    );
  });

  it('идентификатор выводится из названия, пока его не правили руками', () => {
    render(<NewServerPage />);

    fireEvent.change(screen.getByLabelText(/^Название/), { target: { value: 'My Squad' } });
    const slug = screen.getByLabelText(/^Идентификатор/);
    expect(slug).toHaveValue('my-squad');

    // Правка вручную отвязывает идентификатор от названия.
    fireEvent.change(slug, { target: { value: 'eu-main' } });
    fireEvent.change(screen.getByLabelText(/^Название/), { target: { value: 'Other Name' } });
    expect(screen.getByLabelText(/^Идентификатор/)).toHaveValue('eu-main');
  });
});
