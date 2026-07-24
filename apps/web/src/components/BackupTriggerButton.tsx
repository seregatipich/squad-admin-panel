'use client';
import { useEffect, useState } from 'react';

type Phase = 'idle' | 'confirming' | 'running' | 'done' | 'error';

interface Props {
  disabled?: boolean;
  disabledReason?: string;
  /** Called after a successful backup so the parent can refresh the snapshot list. */
  onBackedUp?: () => void;
}

/**
 * Triggers a manual restic backup through `POST /api/v1/host/backups`.
 * Mirrors the confirm-modal state machine of {@link DockerPruneButton}; a
 * backup is safe/non-destructive, so it only needs a single confirm step.
 */
export function BackupTriggerButton({ disabled, disabledReason, onBackedUp }: Props) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [errorText, setErrorText] = useState<string | null>(null);

  useEffect(() => {
    if (phase !== 'done') return;
    const t = setTimeout(() => setPhase('idle'), 8_000);
    return () => clearTimeout(t);
  }, [phase]);

  async function onConfirm() {
    setPhase('running');
    setErrorText(null);
    try {
      const res = await fetch('/api/v1/host/backups', {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
      });
      if (res.status === 403) {
        setErrorText('Нет прав на эту операцию.');
        setPhase('error');
        return;
      }
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { detail?: string };
        setErrorText(`Не удалось создать бэкап: ${j.detail ?? `HTTP ${res.status}`}`);
        setPhase('error');
        return;
      }
      setPhase('done');
      onBackedUp?.();
    } catch (err) {
      setErrorText(`Не удалось дотянуться до агента: ${(err as Error).message}`);
      setPhase('error');
    }
  }

  function close() {
    setPhase('idle');
    setErrorText(null);
  }

  const isModalOpen = phase === 'confirming' || phase === 'running' || phase === 'error';

  return (
    <>
      <button
        type="button"
        onClick={() => setPhase('confirming')}
        disabled={disabled}
        title={disabled ? disabledReason : 'Сделать резервную копию Postgres + Redis сейчас'}
        className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs text-neutral-300 hover:border-sky-700 hover:text-sky-300 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-neutral-800 disabled:hover:text-neutral-300"
      >
        Создать бэкап
      </button>
      {phase === 'done' ? (
        <span className="ml-2 text-xs text-emerald-400">Бэкап создан</span>
      ) : null}

      {isModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-900 p-6 shadow-xl">
            <h3 className="text-lg font-semibold text-neutral-100">Создать бэкап?</h3>
            <p className="mt-2 text-sm text-neutral-300">
              Снимет логический дамп Postgres (pg_dump) и Redis (RDB) и добавит новый restic
              snapshot. Операция безопасна и ничего не перезаписывает. Может занять до минуты.
            </p>

            {phase === 'running' ? (
              <div className="mt-4 flex items-center gap-2 text-sm text-neutral-300">
                <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-neutral-600 border-t-sky-400" />
                <span>Создаю бэкап…</span>
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
                  disabled={phase === 'running'}
                  className="rounded border border-sky-700 bg-sky-900/40 px-3 py-1.5 text-sm text-sky-200 hover:bg-sky-900/60 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Подтвердить
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
