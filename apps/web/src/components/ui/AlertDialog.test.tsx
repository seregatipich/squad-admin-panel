// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AlertDialog } from './AlertDialog';

function dialogIn(container: HTMLElement): HTMLDialogElement {
  const element = container.querySelector('dialog');
  if (!element) throw new Error('AlertDialog не отрисовал <dialog>');
  return element;
}

const CHALLENGE = {
  expected: 'squad-eu-01',
  label: 'Введите имя сервера',
  hint: 'Ожидается: squad-eu-01',
};

type Props = ComponentProps<typeof AlertDialog>;

function alertWith(props: Partial<Props> & { onClose: () => void; onConfirm: () => void }) {
  const merged: Props = {
    open: true,
    title: 'Удалить сервер',
    body: 'Все матчи и логи сервера будут стёрты.',
    confirmLabel: 'Удалить сервер',
    cancelLabel: 'Отмена',
    tone: 'destructive',
    ...props,
  };
  return <AlertDialog {...merged} />;
}

function renderAlert(props: Partial<Props> = {}) {
  const onClose = props.onClose ?? vi.fn();
  const onConfirm = props.onConfirm ?? vi.fn();
  const view = render(alertWith({ ...props, onClose, onConfirm }));
  return { ...view, onClose, onConfirm };
}

/** Крестик и «Отмена» — один и тот же выход, поэтому и подпись у них одна. */
function exits() {
  return screen.getAllByRole('button', { name: 'Отмена' });
}

function confirmButton() {
  return screen.getByRole('button', { name: 'Удалить сервер' });
}

afterEach(cleanup);

describe('AlertDialog', () => {
  it('asks the question inside an open dialog with exactly two answers', () => {
    const { container } = renderAlert();

    expect(dialogIn(container)).toHaveAttribute('open');
    expect(screen.getByRole('dialog', { name: 'Удалить сервер' })).toBeInTheDocument();
    expect(screen.getByText('Все матчи и логи сервера будут стёрты.')).toBeInTheDocument();
    expect(confirmButton()).toBeEnabled();
    expect(exits()).toHaveLength(2);
  });

  it('runs the action on confirm', () => {
    const { onConfirm, onClose } = renderAlert();
    fireEvent.click(confirmButton());
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('reports a refusal from every exit', () => {
    const { onClose, onConfirm } = renderAlert();
    for (const exit of exits()) fireEvent.click(exit);
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('reports a refusal on Escape', () => {
    const { container, onClose } = renderAlert();
    fireEvent.keyDown(dialogIn(container), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('blocks the confirmation until the challenge matches exactly', () => {
    const { onConfirm } = renderAlert({ challenge: CHALLENGE });

    const field = screen.getByLabelText('Введите имя сервера');
    expect(field).toHaveAccessibleDescription('Ожидается: squad-eu-01');
    expect(confirmButton()).toBeDisabled();

    fireEvent.change(field, { target: { value: 'squad-eu-0' } });
    expect(confirmButton()).toBeDisabled();

    fireEvent.change(field, { target: { value: 'SQUAD-EU-01' } });
    expect(confirmButton()).toBeDisabled();

    fireEvent.change(field, { target: { value: 'squad-eu-01 ' } });
    expect(confirmButton()).toBeDisabled();

    fireEvent.click(confirmButton());
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.change(field, { target: { value: 'squad-eu-01' } });
    expect(confirmButton()).toBeEnabled();

    fireEvent.click(confirmButton());
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('clears the challenge between openings', () => {
    const onClose = vi.fn();
    const onConfirm = vi.fn();
    const { rerender } = render(alertWith({ onClose, onConfirm, challenge: CHALLENGE }));

    fireEvent.change(screen.getByLabelText('Введите имя сервера'), {
      target: { value: 'squad-eu-01' },
    });
    expect(confirmButton()).toBeEnabled();

    rerender(alertWith({ open: false, onClose, onConfirm, challenge: CHALLENGE }));
    rerender(alertWith({ open: true, onClose, onConfirm, challenge: CHALLENGE }));

    expect(screen.getByLabelText('Введите имя сервера')).toHaveValue('');
    expect(confirmButton()).toBeDisabled();
  });

  it('locks every exit while the action is running', () => {
    const { container, onClose, onConfirm } = renderAlert({ busy: true });

    fireEvent.keyDown(dialogIn(container), { key: 'Escape' });
    for (const exit of exits()) fireEvent.click(exit);
    fireEvent.click(confirmButton());

    expect(onClose).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(dialogIn(container)).toHaveAttribute('open');
  });

  it('marks the running action on its own button', () => {
    renderAlert({ busy: true });
    expect(confirmButton()).toBeDisabled();
    expect(confirmButton()).toHaveAttribute('aria-busy', 'true');
  });

  it('accepts an asynchronous action', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    renderAlert({ onConfirm, tone: 'default' });
    fireEvent.click(confirmButton());
    await vi.waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
  });
});
