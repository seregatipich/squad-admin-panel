'use client';
import { useEffect, useState } from 'react';

type Phase = 'idle' | 'confirming' | 'running' | 'done' | 'error';

interface Props {
  disabled?: boolean;
  disabledReason?: string;
  /** Called after a successful prune so the parent can refresh disk metrics. */
  onCleaned?: () => void;
}

export function DockerPruneButton({ disabled, disabledReason, onCleaned }: Props) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [errorText, setErrorText] = useState<string | null>(null);
  const [reclaimed, setReclaimed] = useState<string>('');

  useEffect(() => {
    if (phase !== 'done') return;
    const t = setTimeout(() => setPhase('idle'), 12_000);
    return () => clearTimeout(t);
  }, [phase]);

  async function onConfirm() {
    setPhase('running');
    setErrorText(null);
    try {
      const res = await fetch('/api/v1/host/docker-prune', {
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
        setErrorText(`Не удалось очистить: ${j.detail ?? `HTTP ${res.status}`}`);
        setPhase('error');
        return;
      }
      const body = (await res.json()) as { reclaimed_human: string };
      setReclaimed(body.reclaimed_human || '0B');
      setPhase('done');
      onCleaned?.();
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
        title={
          disabled
            ? disabledReason
            : 'Удалить остановленные контейнеры, неиспользуемые образы и build cache'
        }
        className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs text-neutral-300 hover:border-sky-700 hover:text-sky-300 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-neutral-800 disabled:hover:text-neutral-300"
      >
        Очистить docker
      </button>
      {phase === 'done' ? (
        <span className="ml-2 text-xs text-emerald-400">Освобождено: {reclaimed}</span>
      ) : null}

      {isModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-900 p-6 shadow-xl">
            <h3 className="text-lg font-semibold text-neutral-100">Очистить docker?</h3>
            <p className="mt-2 text-sm text-neutral-300">
              Удалит остановленные контейнеры, неиспользуемые образы и весь build cache. Volumes
              (squad-depot и данные серверов) не трогаются. Может занять до минуты.
            </p>

            {phase === 'running' ? (
              <div className="mt-4 flex items-center gap-2 text-sm text-neutral-300">
                <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-neutral-600 border-t-sky-400" />
                <span>Очищаю…</span>
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
