// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiskBreakdownModal } from './DiskBreakdownModal';

/**
 * jsdom 29 знает элемент `<dialog>`, но не реализует `showModal()`/`close()`.
 * Полифилл живёт только в тестах — компонент рассчитан на настоящий браузер.
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

type Usage = NonNullable<Parameters<typeof DiskBreakdownModal>[0]['initialData']>;

const UUID = '019e0000-0000-7000-8000-0000000000aa';

function usage(overrides: Partial<Usage> = {}): Usage {
  return {
    configs_bytes: 1024,
    saved_total_bytes: 4096,
    saved_per_server: [{ uuid: UUID, bytes: 4096 }],
    depot_volume_bytes: 8192,
    docker_volumes: [{ name: 'squad-depot', bytes: 8192 }],
    docker_images: [{ repository: 'squad/api', tag: 'latest', bytes: 2048 }],
    audit_archive_bytes: 512,
    total_panel_bytes: 16384,
    host_total_bytes: 1_000_000,
    host_used_bytes: 500_000,
    computed_at: '2026-08-22T09:00:00.000Z',
    cache_age_seconds: 12,
    panel_pct: 1.6,
    other_pct: 48.4,
    ...overrides,
  };
}

afterEach(cleanup);

describe('DiskBreakdownModal', () => {
  it('exports a React component function', async () => {
    const mod = await import('./DiskBreakdownModal');
    expect(typeof mod.DiskBreakdownModal).toBe('function');
  });

  it('renders nothing while closed', () => {
    const { container } = render(
      <DiskBreakdownModal
        open={false}
        onOpenChange={vi.fn()}
        initialData={usage()}
        onRefresh={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('groups the breakdown and lists Saved per server with a link to the server', () => {
    render(
      <DiskBreakdownModal open onOpenChange={vi.fn()} initialData={usage()} onRefresh={vi.fn()} />,
    );

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Что занимает панель')).toBeInTheDocument();
    expect(within(dialog).getByText('Депо Squad')).toBeInTheDocument();
    expect(within(dialog).getByText('Образы Docker')).toBeInTheDocument();
    expect(within(dialog).getByText('Архив аудита')).toBeInTheDocument();

    const table = within(dialog).getByRole('table', {
      name: 'Место, занятое каталогами Saved по серверам',
    });
    expect(within(table).getByRole('columnheader', { name: 'Сервер' })).toBeInTheDocument();
    expect(within(table).getByRole('link', { name: UUID.slice(0, 8) })).toHaveAttribute(
      'href',
      `/servers/${UUID}`,
    );
  });

  it('reloads the breakdown through the refresh control', async () => {
    const onRefresh = vi.fn().mockResolvedValue(usage({ cache_age_seconds: 0 }));
    render(
      <DiskBreakdownModal
        open
        onOpenChange={vi.fn()}
        initialData={usage()}
        onRefresh={onRefresh}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Обновить' }));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText(/обновлено 0 сек назад/)).toBeInTheDocument());
  });

  it('explains an empty breakdown instead of showing a blank panel', () => {
    render(
      <DiskBreakdownModal open onOpenChange={vi.fn()} initialData={null} onRefresh={vi.fn()} />,
    );
    expect(screen.getByText('Нет данных')).toBeInTheDocument();
  });

  it('asks to close on Escape', () => {
    const onOpenChange = vi.fn();
    render(
      <DiskBreakdownModal
        open
        onOpenChange={onOpenChange}
        initialData={usage()}
        onRefresh={vi.fn()}
      />,
    );
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
