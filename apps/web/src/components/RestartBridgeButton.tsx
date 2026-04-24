'use client';
import { useEffect, useState } from 'react';

type Phase = 'idle' | 'confirming' | 'restarting' | 'restarted' | 'error';

interface Props {
  disabled?: boolean;
  disabledReason?: string;
}

export function RestartBridgeButton({ disabled, disabledReason }: Props) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [errorText, setErrorText] = useState<string | null>(null);

  useEffect(() => {
    if (phase !== 'restarted') return;
    const t = setTimeout(() => setPhase('idle'), 8000);
    return () => clearTimeout(t);
  }, [phase]);

  async function onConfirm() {
    setPhase('restarting');
    setErrorText(null);
    try {
      const res = await fetch('/api/v1/host/restart', {
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
        setErrorText('Не удалось дотянуться до агента. Проверьте логи systemd.');
        setPhase('error');
        return;
      }
      setPhase('restarted');
    } catch {
      setErrorText('Не удалось дотянуться до агента. Проверьте логи systemd.');
      setPhase('error');
    }
  }

  function close() {
    setPhase('idle');
    setErrorText(null);
  }

  const isModalOpen = phase === 'confirming' || phase === 'restarting' || phase === 'error';

  return (
    <>
      <button
        type="button"
        onClick={() => setPhase('confirming')}
        disabled={disabled}
        title={disabled ? disabledReason : 'Перезапустить агент'}
        className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs text-neutral-300 hover:border-amber-700 hover:text-amber-300 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-neutral-800 disabled:hover:text-neutral-300"
      >
        Перезапустить агент
      </button>
      {phase === 'restarted' ? (
        <span className="ml-2 text-xs text-emerald-400">
          Агент перезапускается. Ожидание подключения…
        </span>
      ) : null}

      {isModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-900 p-6 shadow-xl">
            <h3 className="text-lg font-semibold text-neutral-100">Перезапустить агент?</h3>
            <p className="mt-2 text-sm text-neutral-300">
              Перезапустить bridge-агент? Подключение прервётся на ~3 секунды. Эту операцию нельзя
              отменить.
            </p>

            {phase === 'restarting' ? (
              <div className="mt-4 flex items-center gap-2 text-sm text-neutral-300">
                <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-neutral-600 border-t-amber-400" />
                <span>Перезапускаю…</span>
              </div>
            ) : null}

            {phase === 'error' && errorText ? (
              <p className="mt-4 text-sm text-red-400">{errorText}</p>
            ) : null}

            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                onClick={close}
                disabled={phase === 'restarting'}
                className="rounded border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-300 hover:border-neutral-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {phase === 'error' ? 'Закрыть' : 'Отменить'}
              </button>
              {phase !== 'error' ? (
                <button
                  type="button"
                  onClick={onConfirm}
                  disabled={phase === 'restarting'}
                  className="rounded border border-amber-700 bg-amber-900/40 px-3 py-1.5 text-sm text-amber-200 hover:bg-amber-900/60 disabled:cursor-not-allowed disabled:opacity-50"
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
