// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
}));
vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(() => Promise.resolve({ items: [] })),
}));

import { PALETTE_OPEN_EVENT } from '@/lib/commandPalette';
import { CommandPalette } from './CommandPalette';

const PERMISSIONS = ['server:view', 'user:view', 'host:view'];

function renderPalette() {
  return render(<CommandPalette permissions={PERMISSIONS} />);
}

/** Opens the palette the way the top bar's search field does. */
async function open() {
  await act(async () => {
    window.dispatchEvent(new Event(PALETTE_OPEN_EVENT));
  });
}

afterEach(() => {
  cleanup();
  push.mockReset();
});

describe('CommandPalette', () => {
  it('stays closed until asked', () => {
    renderPalette();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens on the top bar request and focuses the search field', async () => {
    renderPalette();
    await open();

    const dialog = screen.getByRole('dialog', { name: 'Командная панель' });
    expect(dialog).toBeInTheDocument();

    const field = screen.getByRole('combobox', { name: 'Командная панель: поиск' });
    await waitFor(() => expect(field).toHaveFocus());
  });

  it('exposes results as a listbox and marks the highlighted row', async () => {
    renderPalette();
    await open();

    const options = screen.getAllByRole('option');
    expect(options.length).toBeGreaterThan(0);
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    expect(options[1]).toHaveAttribute('aria-selected', 'false');

    // The field points screen readers at the highlighted row rather than
    // moving focus, which is what keeps typing uninterrupted.
    const field = screen.getByRole('combobox', { name: 'Командная панель: поиск' });
    expect(field).toHaveAttribute('aria-activedescendant', options[0].id);
  });

  it('moves the highlight with the arrow keys', async () => {
    renderPalette();
    await open();

    const field = screen.getByRole('combobox', { name: 'Командная панель: поиск' });
    fireEvent.keyDown(field, { key: 'ArrowDown' });

    const options = screen.getAllByRole('option');
    expect(options[1]).toHaveAttribute('aria-selected', 'true');
    expect(field).toHaveAttribute('aria-activedescendant', options[1].id);
  });

  it('navigates to the chosen page and closes', async () => {
    renderPalette();
    await open();

    const first = screen.getAllByRole('option')[0];
    fireEvent.click(first);

    expect(push).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('closes on Escape and on a click outside the panel', async () => {
    renderPalette();
    await open();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await open();
    fireEvent.click(screen.getByRole('dialog'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('reports an empty search instead of showing a blank list', async () => {
    renderPalette();
    await open();

    const field = screen.getByRole('combobox', { name: 'Командная панель: поиск' });
    fireEvent.change(field, { target: { value: 'zzzzzzzz-нет-такой-страницы' } });

    expect(await screen.findByText('Ничего не найдено.')).toBeInTheDocument();
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });
});
