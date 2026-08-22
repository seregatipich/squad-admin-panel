// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DepotUpdateModal } from './DepotUpdateModal';

/**
 * jsdom 29 знает элемент `<dialog>`, но не реализует `showModal()`/`close()`,
 * а окно построено на примитиве `Modal`. Полифилл повторяет ровно то, на что
 * опирается примитив: атрибут `open`, фокус внутрь окна и цепочку
 * Escape → отменяемое `cancel` → `close`.
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

const STOPPED = { id: 'srv-3', display_name: 'Остановленный', status: 'stopped', player_count: 0 };

const SERVERS = [
  { id: 'srv-1', display_name: 'Первый', status: 'running', player_count: 1 },
  { id: 'srv-2', display_name: 'Второй', status: 'starting', player_count: 42 },
  STOPPED,
];

afterEach(cleanup);

describe('DepotUpdateModal', () => {
  it('keeps the dialog closed until asked to open', () => {
    render(
      <DepotUpdateModal
        open={false}
        onOpenChange={() => {}}
        servers={SERVERS}
        onStart={async () => {}}
      />,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('offers only the servers that are actually running', () => {
    render(
      <DepotUpdateModal open onOpenChange={() => {}} servers={SERVERS} onStart={async () => {}} />,
    );
    const dialog = screen.getByRole('dialog', { name: 'Обновить Squad' });
    expect(within(dialog).getByRole('checkbox', { name: 'Первый' })).toBeInTheDocument();
    expect(within(dialog).getByRole('checkbox', { name: 'Второй' })).toBeInTheDocument();
    expect(within(dialog).queryByRole('checkbox', { name: 'Остановленный' })).toBeNull();
  });

  it('starts the update with exactly the checked servers', async () => {
    const onStart = vi.fn(async () => {});
    const onOpenChange = vi.fn();
    render(
      <DepotUpdateModal open onOpenChange={onOpenChange} servers={SERVERS} onStart={onStart} />,
    );
    fireEvent.click(screen.getByRole('checkbox', { name: 'Второй' }));
    fireEvent.click(screen.getByRole('button', { name: 'Начать обновление' }));

    await waitFor(() => expect(onStart).toHaveBeenCalledWith(['srv-2']));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('forgets the previous selection when reopened', async () => {
    // Окно больше не размонтируется при закрытии — нативный `<dialog>` должен
    // остаться в разметке, чтобы вернуть фокус на кнопку, которая его открыла.
    // Поэтому выбор обязан сбрасываться явно: иначе галочки, поставленные и
    // передуманные час назад, уедут в запрос на остановку боевых серверов.
    const onStart = vi.fn(async () => {});
    const { rerender } = render(
      <DepotUpdateModal open onOpenChange={() => {}} servers={SERVERS} onStart={onStart} />,
    );

    fireEvent.click(screen.getByRole('checkbox', { name: 'Первый' }));
    expect(screen.getByRole('checkbox', { name: 'Первый' })).toBeChecked();

    rerender(
      <DepotUpdateModal open={false} onOpenChange={() => {}} servers={SERVERS} onStart={onStart} />,
    );
    rerender(<DepotUpdateModal open onOpenChange={() => {}} servers={SERVERS} onStart={onStart} />);

    expect(screen.getByRole('checkbox', { name: 'Первый' })).not.toBeChecked();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Второй' }));
    fireEvent.click(screen.getByRole('button', { name: 'Начать обновление' }));
    await waitFor(() => expect(onStart).toHaveBeenCalledWith(['srv-2']));
  });

  it('explains the empty case instead of showing a bare list', () => {
    render(
      <DepotUpdateModal
        open
        onOpenChange={() => {}}
        servers={[STOPPED]}
        onStart={async () => {}}
      />,
    );
    expect(screen.getByText('Нет запущенных серверов')).toBeInTheDocument();
  });

  it('closes on Отмена', () => {
    const onOpenChange = vi.fn();
    render(
      <DepotUpdateModal
        open
        onOpenChange={onOpenChange}
        servers={SERVERS}
        onStart={async () => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Отмена' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
