// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RestoreSnapshotButton } from './RestoreSnapshotButton';

const SHORT_ID = 'a1b2c3d4';

/** The modal's primary action button (distinct from the row trigger of the same name). */
function confirmButton() {
  return within(screen.getByRole('dialog')).getByRole('button', { name: 'Восстановить' });
}

/** The row trigger — the only "Восстановить" button before the modal opens. */
function openModal() {
  fireEvent.click(screen.getByRole('button', { name: 'Восстановить' }));
}

function typeConfirm(value: string) {
  fireEvent.change(screen.getByLabelText(/для подтверждения/i), { target: { value } });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mockFetch(response: Response | (() => Promise<Response>)) {
  const fn = typeof response === 'function' ? response : () => Promise.resolve(response);
  const spy = vi.fn(fn);
  vi.stubGlobal('fetch', spy);
  return spy;
}

describe('RestoreSnapshotButton', () => {
  it('opens a typed-confirm modal referencing the snapshot id', () => {
    render(<RestoreSnapshotButton shortId={SHORT_ID} />);
    openModal();
    expect(screen.getByText('Восстановить из бэкапа?')).toBeInTheDocument();
    expect(within(screen.getByRole('dialog')).getAllByText(SHORT_ID).length).toBeGreaterThan(0);
  });

  it('keeps the confirm button disabled until the typed id matches', () => {
    render(<RestoreSnapshotButton shortId={SHORT_ID} />);
    openModal();
    expect(confirmButton()).toBeDisabled();
    typeConfirm('a1b2');
    expect(confirmButton()).toBeDisabled();
    typeConfirm(SHORT_ID);
    expect(confirmButton()).toBeEnabled();
  });

  it('POSTs the confirm token to the restore endpoint and reports success', async () => {
    const fetchSpy = mockFetch(new Response(JSON.stringify({ ok: true, exit_code: 0 })));
    const onRestored = vi.fn();
    render(<RestoreSnapshotButton shortId={SHORT_ID} onRestored={onRestored} />);
    openModal();
    typeConfirm(SHORT_ID);
    fireEvent.click(confirmButton());

    await waitFor(() => expect(onRestored).toHaveBeenCalledTimes(1));
    expect(fetchSpy).toHaveBeenCalledWith(
      `/api/v1/host/backups/${SHORT_ID}/restore`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ confirm: SHORT_ID }),
      }),
    );
    expect(screen.getByText(`Восстановлено из ${SHORT_ID}`)).toBeInTheDocument();
  });

  it('does not call the API while the typed token is blank (button disabled)', () => {
    const fetchSpy = mockFetch(new Response('{}'));
    render(<RestoreSnapshotButton shortId={SHORT_ID} />);
    openModal();
    fireEvent.click(confirmButton());
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('shows a permission error on 403', async () => {
    mockFetch(new Response('', { status: 403 }));
    render(<RestoreSnapshotButton shortId={SHORT_ID} />);
    openModal();
    typeConfirm(SHORT_ID);
    fireEvent.click(confirmButton());
    await waitFor(() => expect(screen.getByText('Нет прав на эту операцию.')).toBeInTheDocument());
  });

  it('surfaces the API detail on a non-ok, non-403 response', async () => {
    mockFetch(new Response(JSON.stringify({ detail: 'restore.sh exit 1' }), { status: 502 }));
    render(<RestoreSnapshotButton shortId={SHORT_ID} />);
    openModal();
    typeConfirm(SHORT_ID);
    fireEvent.click(confirmButton());
    await waitFor(() =>
      expect(screen.getByText('Не удалось восстановить: restore.sh exit 1')).toBeInTheDocument(),
    );
  });

  it('falls back to the HTTP status when the error body is not JSON', async () => {
    mockFetch(new Response('boom', { status: 500 }));
    render(<RestoreSnapshotButton shortId={SHORT_ID} />);
    openModal();
    typeConfirm(SHORT_ID);
    fireEvent.click(confirmButton());
    await waitFor(() =>
      expect(screen.getByText('Не удалось восстановить: HTTP 500')).toBeInTheDocument(),
    );
  });

  it('shows a transport error when fetch throws', async () => {
    mockFetch(() => Promise.reject(new Error('ECONNRESET')));
    render(<RestoreSnapshotButton shortId={SHORT_ID} />);
    openModal();
    typeConfirm(SHORT_ID);
    fireEvent.click(confirmButton());
    await waitFor(() =>
      expect(screen.getByText('Не удалось дотянуться до агента: ECONNRESET')).toBeInTheDocument(),
    );
  });

  it('closes the modal via Cancel', () => {
    render(<RestoreSnapshotButton shortId={SHORT_ID} />);
    openModal();
    fireEvent.click(screen.getByRole('button', { name: 'Отменить' }));
    expect(screen.queryByText('Восстановить из бэкапа?')).not.toBeInTheDocument();
  });

  it('closes the error modal via the Закрыть button', async () => {
    mockFetch(new Response('', { status: 403 }));
    render(<RestoreSnapshotButton shortId={SHORT_ID} />);
    openModal();
    typeConfirm(SHORT_ID);
    fireEvent.click(confirmButton());
    await waitFor(() => expect(screen.getByText('Нет прав на эту операцию.')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Закрыть' }));
    expect(screen.queryByText('Восстановить из бэкапа?')).not.toBeInTheDocument();
  });

  it('renders the snapshot time in the confirm dialog when provided', () => {
    render(<RestoreSnapshotButton shortId={SHORT_ID} time="2026-07-24 03:00" />);
    openModal();
    expect(screen.getByText(/2026-07-24 03:00/)).toBeInTheDocument();
  });

  it('renders disabled with the reason as the title', () => {
    render(<RestoreSnapshotButton shortId={SHORT_ID} disabled disabledReason="нет прав" />);
    const btn = screen.getByRole('button', { name: 'Восстановить' });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', 'нет прав');
  });
});
