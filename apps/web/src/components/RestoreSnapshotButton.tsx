'use client';
import { useState } from 'react';
import { AlertDialog, Button, InlineBanner } from '@/components/ui';

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
 *
 * Ввод строки теперь ведёт сам {@link AlertDialog} (`challenge`), поэтому
 * барьер здесь ровно тот же, что у остальных необратимых операций панели, а
 * окно получило ловушку фокуса и Escape нативного `<dialog>`.
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

  function close() {
    setPhase('idle');
    setErrorText(null);
  }

  const isModalOpen = phase === 'confirming' || phase === 'running' || phase === 'error';

  return (
    <>
      <Button
        onClick={() => setPhase('confirming')}
        disabled={disabled}
        title={disabled ? disabledReason : `Восстановить snapshot ${shortId} (перезапишет данные)`}
      >
        Восстановить
      </Button>
      {phase === 'done' ? (
        <span className="ml-2 text-xs text-good">Восстановлено из {shortId}</span>
      ) : null}

      {isModalOpen ? (
        <AlertDialog
          open
          onClose={close}
          title="Восстановить из бэкапа?"
          tone="destructive"
          body={
            <>
              <p>
                Snapshot <span className="font-mono text-ink">{shortId}</span>
                {time ? <span className="text-ink-3"> ({time})</span> : null} будет восстановлен.
                Это <strong className="font-semibold text-crit">перезапишет</strong> текущие базы
                Postgres и Redis — все изменения с момента снимка будут потеряны.
              </p>
              {phase === 'error' && errorText ? (
                <div className="mt-3">
                  <InlineBanner tone="crit" title={errorText} />
                </div>
              ) : null}
            </>
          }
          challenge={{
            expected: shortId,
            label: `Введите ${shortId} для подтверждения`,
          }}
          confirmLabel="Восстановить"
          cancelLabel={phase === 'error' ? 'Закрыть' : 'Отменить'}
          busy={phase === 'running'}
          onConfirm={onConfirm}
        />
      ) : null}
    </>
  );
}
