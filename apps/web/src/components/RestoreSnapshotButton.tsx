'use client';
import { useId, useState } from 'react';

type Phase = 'idle' | 'confirming' | 'running' | 'done' | 'error';

interface Props {
  /** restic short id — used as the restore target, the typed-confirm token, and the label. */
  shortId: string;
  /** RFC3339 snapshot time, for the confirm dialog context. */
  time?: string;
  disabled?: boolean;
  disabledReason?: string;
  /** Called after a successful restore. */
  onRestored?: () => void;
}

/**
 * Restores a chosen restic snapshot through
 * `POST /api/v1/host/backups/:id/restore`. This OVERWRITES the live database,
 * so it is gated by a strong typed confirmation: the operator must type the
 * snapshot's short id, which is then sent as the `confirm` token the API
 * re-checks. Modeled on {@link DockerPruneButton}'s modal state machine.
 */
export function RestoreSnapshotButton({
  shortId,
  time,
  disabled,
  disabledReason,
  onRestored,
}: Props) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [errorText, setErrorText] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const inputId = useId();

  // Gates the Restore button: the operator must type the snapshot's short id.
  const confirmMatches = typed.trim() === shortId;

  async function onConfirm() {
    setPhase('running');
    setErrorText(null);
    try {
      const res = await fetch(`/api/v1/host/backups/${encodeURIComponent(shortId)}/restore`, {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: shortId }),
      });
      if (res.status === 403) {
        setErrorText('Нет прав на эту операцию.');
        setPhase('error');
        return;
      }
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { detail?: string };
        setErrorText(`Не удалось восстановить: ${j.detail ?? `HTTP ${res.status}`}`);
        setPhase('error');
        return;
      }
      setPhase('done');
      onRestored?.();
    } catch (err) {
      setErrorText(`Не удалось дотянуться до агента: ${(err as Error).message}`);
      setPhase('error');
    }
  }

  function open() {
    setTyped('');
    setErrorText(null);
    setPhase('confirming');
  }

  function close() {
    setPhase('idle');
    setErrorText(null);
    setTyped('');
  }

  const isModalOpen = phase === 'confirming' || phase === 'running' || phase === 'error';

  return (
    <>
      <button
        type="button"
        onClick={open}
        disabled={disabled}
        title={disabled ? disabledReason : `Восстановить snapshot ${shortId} (перезапишет данные)`}
        className="rounded border border-red-900 bg-neutral-900 px-2 py-1 text-xs text-red-300 hover:border-red-700 hover:text-red-200 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-red-900 disabled:hover:text-red-300"
      >
        Восстановить
      </button>
      {phase === 'done' ? (
        <span className="ml-2 text-xs text-emerald-400">Восстановлено из {shortId}</span>
      ) : null}

      {isModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Восстановление из бэкапа"
            className="w-full max-w-md rounded-xl border border-red-900 bg-zinc-900 p-6 shadow-xl"
          >
            <h3 className="text-lg font-semibold text-red-200">Восстановить из бэкапа?</h3>
            <p className="mt-2 text-sm text-neutral-300">
              Snapshot <span className="font-mono text-red-300">{shortId}</span>
              {time ? <span className="text-neutral-500"> ({time})</span> : null} будет
              восстановлен. Это <strong className="text-red-300">перезапишет</strong> текущие базы
              Postgres и Redis — все изменения с момента снимка будут потеряны.
            </p>

            {phase !== 'running' ? (
              <div className="mt-4">
                <label htmlFor={inputId} className="mb-1 block text-xs text-neutral-400">
                  Введите <span className="font-mono text-red-300">{shortId}</span> для
                  подтверждения
                </label>
                <input
                  id={inputId}
                  type="text"
                  autoComplete="off"
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  className="w-full rounded border border-neutral-800 bg-neutral-950 px-3 py-2 font-mono text-sm text-neutral-100 focus:border-red-700 focus:outline-none"
                />
              </div>
            ) : null}

            {phase === 'running' ? (
              <div className="mt-4 flex items-center gap-2 text-sm text-neutral-300">
                <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-neutral-600 border-t-red-400" />
                <span>Восстанавливаю…</span>
              </div>
            ) : null}

            {phase === 'error' && errorText ? (
              <p className="mt-4 text-sm text-red-400">{errorText}</p>
            ) : null}

            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                onClick={close}
                disabled={phase === 'running'}
                className="rounded border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-300 hover:border-neutral-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {phase === 'error' ? 'Закрыть' : 'Отменить'}
              </button>
              {phase !== 'error' ? (
                <button
                  type="button"
                  onClick={onConfirm}
                  disabled={phase === 'running' || !confirmMatches}
                  className="rounded border border-red-700 bg-red-900/40 px-3 py-1.5 text-sm text-red-200 hover:bg-red-900/60 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Восстановить
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
