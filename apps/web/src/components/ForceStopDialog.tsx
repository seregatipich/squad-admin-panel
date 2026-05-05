'use client';

import { useEffect, useId, useState } from 'react';

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  serverName: string;
  onConfirm: () => Promise<void>;
}

export function ForceStopDialog({ open, onOpenChange, serverName, onConfirm }: Props) {
  const titleId = useId();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onOpenChange]);

  if (!open) return null;

  async function handleConfirm() {
    setBusy(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch {
      // caller handles error
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onClick={() => onOpenChange(false)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onOpenChange(false);
      }}
    >
      <div
        className="w-full max-w-md rounded border border-neutral-800 bg-neutral-950 p-6"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        role="document"
      >
        <h2 id={titleId} className="mb-3 text-lg font-semibold text-neutral-100">
          Принудительная остановка
        </h2>
        <p className="mb-4 text-sm text-neutral-300">
          Сервер <strong>{serverName}</strong> будет немедленно остановлен без сохранения. Все
          игроки будут отключены.
        </p>
        <p className="mb-5 text-xs text-red-400">Это действие нельзя отменить.</p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="rounded border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-300 hover:border-neutral-700"
          >
            Отмена
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={handleConfirm}
            className="rounded bg-red-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-600 disabled:opacity-50"
          >
            {busy ? 'Остановка...' : 'Остановить принудительно'}
          </button>
        </div>
      </div>
    </div>
  );
}
