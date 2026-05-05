'use client';

import { useEffect, useId, useState } from 'react';

interface ServerEntry {
  id: string;
  display_name: string;
  status: string;
  player_count: number;
}

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  servers: ServerEntry[];
  onStart: (serverIds: string[]) => Promise<void>;
}

export function DepotUpdateModal({ open, onOpenChange, servers, onStart }: Props) {
  const titleId = useId();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const runnableServers = servers.filter((s) => ['running', 'starting'].includes(s.status));

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onOpenChange]);

  if (!open) return null;

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleStart() {
    setBusy(true);
    try {
      await onStart(Array.from(selected));
      onOpenChange(false);
    } catch {
      // caller handles
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
        className="w-full max-w-lg rounded border border-neutral-800 bg-neutral-950 p-6"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        role="document"
      >
        <h2 id={titleId} className="mb-3 text-lg font-semibold text-neutral-100">
          Обновить Squad
        </h2>

        {runnableServers.length > 0 ? (
          <>
            <p className="mb-3 text-sm text-neutral-300">
              Эти серверы будут остановлены на время обновления (~10 мин):
            </p>
            <div className="mb-4 space-y-2">
              {runnableServers.map((s) => (
                <label
                  key={s.id}
                  className="flex cursor-pointer items-center gap-2 rounded border border-neutral-800 px-3 py-2 hover:border-neutral-700"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(s.id)}
                    onChange={() => toggle(s.id)}
                    className="accent-sky-600"
                  />
                  <span className="flex-1 text-sm text-neutral-200">{s.display_name}</span>
                  <span className="text-xs text-neutral-500">
                    {s.player_count} {s.player_count === 1 ? 'игрок' : 'игроков'}
                  </span>
                </label>
              ))}
            </div>
          </>
        ) : (
          <p className="mb-4 text-sm text-neutral-400">Нет запущенных серверов.</p>
        )}

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
            onClick={handleStart}
            className="rounded bg-sky-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-600 disabled:opacity-50"
          >
            {busy ? 'Обновление...' : 'Начать обновление'}
          </button>
        </div>
      </div>
    </div>
  );
}
