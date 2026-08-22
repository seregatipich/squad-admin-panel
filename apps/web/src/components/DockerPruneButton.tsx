'use client';
import { useEffect, useState } from 'react';
import { AlertDialog, Button, InlineBanner } from '@/components/ui';

type Phase = 'idle' | 'confirming' | 'running' | 'done' | 'error';

interface Props {
  disabled?: boolean;
  disabledReason?: string;
  /** Called after a successful prune so the parent can refresh disk metrics. */
  onCleaned?: () => void;
}

/**
 * Очистка docker на хосте через `POST /api/v1/host/docker-prune`.
 *
 * Подтверждение — {@link AlertDialog} с тоном `destructive`: образы и build
 * cache удаляются безвозвратно. Ввода строки нет — volumes с данными операция
 * не трогает, и цена ошибки здесь измеряется временем повторной сборки, а не
 * потерянными данными.
 */
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
      <Button
        onClick={() => setPhase('confirming')}
        disabled={disabled}
        title={
          disabled
            ? disabledReason
            : 'Удалить остановленные контейнеры, неиспользуемые образы и build cache'
        }
      >
        Очистить docker
      </Button>
      {phase === 'done' ? (
        <span className="ml-2 text-xs text-good">Освобождено: {reclaimed}</span>
      ) : null}

      {isModalOpen ? (
        <AlertDialog
          open
          onClose={close}
          title="Очистить docker?"
          tone="destructive"
          body={
            <>
              <p>
                Удалит остановленные контейнеры, неиспользуемые образы и весь build cache. Volumes
                (squad-depot и данные серверов) не трогаются. Может занять до минуты.
              </p>
              {phase === 'error' && errorText ? (
                <div className="mt-3">
                  <InlineBanner tone="crit" title={errorText} />
                </div>
              ) : null}
            </>
          }
          confirmLabel={phase === 'error' ? 'Повторить' : 'Очистить docker'}
          cancelLabel={phase === 'error' ? 'Закрыть' : 'Отменить'}
          busy={phase === 'running'}
          onConfirm={onConfirm}
        />
      ) : null}
    </>
  );
}
