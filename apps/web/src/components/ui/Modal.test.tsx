// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Modal } from './Modal';

/**
 * jsdom 29 знает элемент `<dialog>` и свойство `open`, но не реализует
 * `showModal()`/`close()`. Полифилл живёт только здесь: в продакшн-коде он
 * означал бы, что примитив рассчитывает не на браузер, а на подпорку.
 *
 * Воспроизводится ровно то поведение, на которое опирается компонент: атрибут
 * `open`, перевод фокуса внутрь окна, Escape → отменяемое `cancel` → `close`.
 */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const escapeHandlers = new WeakMap<HTMLDialogElement, (event: KeyboardEvent) => void>();

if (typeof HTMLDialogElement.prototype.showModal !== 'function') {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const notPrevented = this.dispatchEvent(new Event('cancel', { cancelable: true }));
      if (notPrevented) this.close();
    };
    escapeHandlers.set(this, onKeyDown);
    this.addEventListener('keydown', onKeyDown);
    this.querySelector<HTMLElement>(FOCUSABLE)?.focus();
  };

  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement, value?: string) {
    if (value !== undefined) this.returnValue = value;
    this.removeAttribute('open');
    const onKeyDown = escapeHandlers.get(this);
    if (onKeyDown) {
      this.removeEventListener('keydown', onKeyDown);
      escapeHandlers.delete(this);
    }
    this.dispatchEvent(new Event('close'));
  };
}

/**
 * Закрытый `<dialog>` может не иметь доступной роли, поэтому в тестах, которые
 * проверяют именно закрытое состояние, элемент берётся по тегу.
 */
function dialogIn(container: HTMLElement): HTMLDialogElement {
  const element = container.querySelector('dialog');
  if (!element) throw new Error('Modal не отрисовал <dialog>');
  return element;
}

type Props = ComponentProps<typeof Modal>;

function modalWith(props: Partial<Props> & { onClose: () => void }) {
  const { children, ...rest } = props;
  return (
    <Modal open title="Перезапуск сервера" closeLabel="Закрыть" {...rest}>
      {children ?? <p>Сессия будет прервана.</p>}
    </Modal>
  );
}

function renderModal(props: Partial<Props> = {}) {
  const onClose = props.onClose ?? vi.fn();
  const view = render(modalWith({ ...props, onClose }));
  return { ...view, onClose };
}

afterEach(cleanup);

describe('Modal', () => {
  it('opens the native dialog and names it by its heading', () => {
    renderModal({ description: 'Игроки будут отключены.' });

    const modal = screen.getByRole('dialog', { name: 'Перезапуск сервера' });
    expect(modal).toHaveAttribute('open');
    expect(modal).toHaveAccessibleDescription('Игроки будут отключены.');
    expect(screen.getByText('Сессия будет прервана.')).toBeInTheDocument();
  });

  it('carries the classes that keep the window centred', () => {
    // Регрессия: без них окно появлялось в левом верхнем углу экрана. Браузер
    // центрирует модальный `<dialog>` через `inset: 0` + `margin: auto`, но
    // сброс Tailwind обнуляет поля, а `height: auto` при `inset: 0` растягивает
    // элемент на всю высоту. jsdom не считает раскладку, поэтому проверяется
    // сам контракт классов — единственное, что здесь вообще наблюдаемо.
    renderModal();
    const dialog = screen.getByRole('dialog');
    expect(dialog.className).toContain('m-auto');
    expect(dialog.className).toContain('h-fit');
  });

  it('never forces a display on a closed dialog', () => {
    // Регрессия: безусловный `flex` перебивал браузерное `display: none` у
    // закрытого `<dialog>`, и каждое смонтированное окно — по одному на строку
    // таблицы — рисовалось прямо в потоке страницы. Раскладка окна включается
    // только вместе с ним самим.
    renderModal({ open: false });
    const dialog = screen.getByRole('dialog', { hidden: true });
    expect(dialog).not.toHaveAttribute('open');
    expect(dialog.className).not.toMatch(/(^|\s)flex(\s|$)/);
    expect(dialog.className).not.toMatch(/(^|\s)flex-col(\s|$)/);
    expect(dialog.className).toContain('open:flex');
    expect(dialog.className).toContain('open:flex-col');
  });

  it('keeps exactly one scroll area — the body, not the window', () => {
    // Регрессия: окно и тело ограничивали высоту каждый по-своему, и на
    // длинном содержимом рядом появлялись две полосы прокрутки.
    renderModal();
    const dialog = screen.getByRole('dialog');
    expect(dialog.className).toContain('overflow-hidden');
    const scrollers = Array.from(dialog.querySelectorAll('div')).filter((node) =>
      node.className.includes('overflow-y-auto'),
    );
    expect(scrollers).toHaveLength(1);
    expect(scrollers[0]?.className).toContain('flex-1');
  });

  it('leaves the description wiring out when there is no description', () => {
    const { container } = renderModal();
    expect(dialogIn(container)).not.toHaveAttribute('aria-describedby');
  });

  it('renders the footer actions', () => {
    renderModal({ footer: <button type="button">Перезапустить</button> });
    expect(screen.getByRole('button', { name: 'Перезапустить' })).toBeInTheDocument();
  });

  it('moves focus inside the dialog when it opens', () => {
    const { container } = renderModal();
    expect(document.activeElement).not.toBe(document.body);
    expect(dialogIn(container).contains(document.activeElement)).toBe(true);
  });

  it('stays closed until asked to open', () => {
    const onClose = vi.fn();
    const { container, rerender } = render(modalWith({ open: false, onClose }));
    expect(dialogIn(container)).not.toHaveAttribute('open');

    rerender(modalWith({ open: true, onClose }));
    expect(dialogIn(container)).toHaveAttribute('open');
  });

  it('closes on Escape', () => {
    const { container, onClose } = renderModal();
    fireEvent.keyDown(dialogIn(container), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps the dialog open on Escape when it is not dismissible', () => {
    const { container, onClose } = renderModal({ dismissible: false });
    fireEvent.keyDown(dialogIn(container), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(dialogIn(container)).toHaveAttribute('open');
  });

  it('reports a close exactly once per opening, though Escape fires cancel and close', () => {
    const onClose = vi.fn();
    const { container, rerender } = render(modalWith({ onClose }));

    fireEvent.keyDown(dialogIn(container), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    rerender(modalWith({ open: false, onClose }));
    rerender(modalWith({ open: true, onClose }));
    fireEvent.keyDown(dialogIn(container), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('does not report a close when the owner closes it through the prop', () => {
    const onClose = vi.fn();
    const { container, rerender } = render(modalWith({ onClose }));

    rerender(modalWith({ open: false, onClose }));
    expect(dialogIn(container)).not.toHaveAttribute('open');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes from the close button', () => {
    const { onClose } = renderModal();
    fireEvent.click(screen.getByRole('button', { name: 'Закрыть' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes from the close button even when it is not dismissible', () => {
    const { onClose } = renderModal({ dismissible: false });
    fireEvent.click(screen.getByRole('button', { name: 'Закрыть' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on a backdrop click', () => {
    const { container, onClose } = renderModal();
    fireEvent.click(dialogIn(container));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ignores a click on the content inside the dialog', () => {
    const { onClose } = renderModal();
    fireEvent.click(screen.getByText('Сессия будет прервана.'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('ignores a backdrop click when it is not dismissible', () => {
    const { container, onClose } = renderModal({ dismissible: false });
    fireEvent.click(dialogIn(container));
    expect(onClose).not.toHaveBeenCalled();
  });
});
