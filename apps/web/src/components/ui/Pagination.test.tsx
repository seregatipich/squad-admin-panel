// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Pagination, type PaginationLabels } from './Pagination';

const LABELS: PaginationLabels = {
  previous: 'Назад',
  next: 'Вперёд',
  page: (page, of) => `Страница ${page} из ${of}`,
};

function renderPagination(props: Omit<Partial<Parameters<typeof Pagination>[0]>, 'onChange'> = {}) {
  const onChange = vi.fn<(page: number) => void>();
  const view = render(
    <Pagination page={1} pageCount={5} labels={LABELS} {...props} onChange={onChange} />,
  );
  return { ...view, onChange };
}

/** Настоящий список: страница меняется, и поле номера обязано это отразить. */
function Harness() {
  const [page, setPage] = useState(1);
  return <Pagination page={page} pageCount={128} onChange={setPage} labels={LABELS} allowJump />;
}

afterEach(cleanup);

describe('Pagination', () => {
  it('names the navigation block by the page it is currently on', () => {
    renderPagination({ page: 3 });
    expect(screen.getByRole('navigation', { name: 'Страница 3 из 5' })).toBeInTheDocument();
    expect(screen.getByText('Страница 3 из 5')).toBeInTheDocument();
  });

  it('never draws a row of page numbers', () => {
    renderPagination({ page: 3, pageCount: 128 });
    expect(screen.getAllByRole('button')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: '2' })).not.toBeInTheDocument();
  });

  it('blocks the step back on the first page', () => {
    const { onChange } = renderPagination({ page: 1 });
    expect(screen.getByRole('button', { name: 'Назад' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Вперёд' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Назад' }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('blocks the step forward on the last page', () => {
    const { onChange } = renderPagination({ page: 5, pageCount: 5 });
    expect(screen.getByRole('button', { name: 'Вперёд' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Назад' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Вперёд' }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('blocks both steps when there is a single page', () => {
    renderPagination({ page: 1, pageCount: 1 });
    expect(screen.getByRole('button', { name: 'Назад' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Вперёд' })).toBeDisabled();
  });

  it('asks for the neighbouring page on each step', () => {
    const { onChange } = renderPagination({ page: 3 });

    fireEvent.click(screen.getByRole('button', { name: 'Вперёд' }));
    expect(onChange).toHaveBeenLastCalledWith(4);

    fireEvent.click(screen.getByRole('button', { name: 'Назад' }));
    expect(onChange).toHaveBeenLastCalledWith(2);
  });

  it('offers the number field only on a long list that allows jumping', () => {
    renderPagination({ pageCount: 128 });
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
    cleanup();

    renderPagination({ pageCount: 10, allowJump: true });
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
    cleanup();

    renderPagination({ pageCount: 11, allowJump: true });
    expect(screen.getByRole('spinbutton')).toBeInTheDocument();
  });

  it('jumps to the typed page on Enter', () => {
    const { onChange } = renderPagination({ pageCount: 128, allowJump: true });
    const jump = screen.getByRole('spinbutton');

    fireEvent.change(jump, { target: { value: '42' } });
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.keyDown(jump, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledExactlyOnceWith(42);
  });

  it('jumps when the field loses focus', () => {
    const { onChange } = renderPagination({ pageCount: 128, allowJump: true });
    const jump = screen.getByRole('spinbutton');

    fireEvent.change(jump, { target: { value: '7' } });
    fireEvent.blur(jump);
    expect(onChange).toHaveBeenCalledExactlyOnceWith(7);
  });

  it('pulls a number outside the list to the nearest page that exists', () => {
    const { onChange } = renderPagination({ page: 2, pageCount: 128, allowJump: true });
    const jump = screen.getByRole('spinbutton');

    fireEvent.change(jump, { target: { value: '9999' } });
    fireEvent.keyDown(jump, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith(128);
    expect(jump).toHaveValue(128);

    fireEvent.change(jump, { target: { value: '0' } });
    fireEvent.keyDown(jump, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith(1);
  });

  it('restores the current page when the field is left empty or unreadable', () => {
    const { onChange } = renderPagination({ page: 4, pageCount: 128, allowJump: true });
    const jump = screen.getByRole('spinbutton');

    fireEvent.change(jump, { target: { value: '' } });
    fireEvent.keyDown(jump, { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalled();
    expect(jump).toHaveValue(4);
  });

  it('does not ask for the page it is already on', () => {
    const { onChange } = renderPagination({ page: 4, pageCount: 128, allowJump: true });
    const jump = screen.getByRole('spinbutton');

    fireEvent.change(jump, { target: { value: '4' } });
    fireEvent.keyDown(jump, { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('follows the page when it changes by a step', () => {
    render(<Harness />);
    const jump = screen.getByRole('spinbutton');

    fireEvent.change(jump, { target: { value: '42' } });
    fireEvent.keyDown(jump, { key: 'Enter' });
    expect(screen.getByText('Страница 42 из 128')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Вперёд' }));
    expect(screen.getByText('Страница 43 из 128')).toBeInTheDocument();
    expect(jump).toHaveValue(43);
  });
});
