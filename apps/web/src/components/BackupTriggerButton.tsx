'use client';
import { useEffect, useState } from 'react';
import { AlertDialog, Button, InlineBanner } from '@/components/ui';

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
 *
 * Подтверждение идёт через {@link AlertDialog} — нативный `<dialog>` с
 * ловушкой фокуса и работающим Escape. Тон обычный, а не `destructive`:
 * бэкап ничего не перезаписывает и не удаляет, а критический цвет по §5
 * зарезервирован за необратимым разрушением данных.
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
      <Button
        onClick={() => setPhase('confirming')}
        disabled={disabled}
        title={disabled ? disabledReason : 'Сделать резервную копию Postgres + Redis сейчас'}
      >
        Создать бэкап
      </Button>
      {phase === 'done' ? <span className="ml-2 text-xs text-good">Бэкап создан</span> : null}

      {/* Окно монтируется только на время вопроса: закрытый `<dialog>` остаётся
          в разметке, и его содержимое иначе продолжало бы отвечать на поиск. */}
      {isModalOpen ? (
        <AlertDialog
          open
          onClose={close}
          title="Создать бэкап?"
          tone="default"
          body={
            <>
              <p>
                Снимет логический дамп Postgres (pg_dump) и Redis (RDB) и добавит новый restic
                snapshot. Операция безопасна и ничего не перезаписывает. Может занять до минуты.
              </p>
              {phase === 'error' && errorText ? (
                <div className="mt-3">
                  <InlineBanner tone="crit" title={errorText} />
                </div>
              ) : null}
            </>
          }
          confirmLabel={phase === 'error' ? 'Повторить' : 'Создать бэкап'}
          cancelLabel={phase === 'error' ? 'Закрыть' : 'Отменить'}
          busy={phase === 'running'}
          onConfirm={onConfirm}
        />
      ) : null}
    </>
  );
}
