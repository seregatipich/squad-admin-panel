'use client';
import { useEffect, useState } from 'react';
import { AlertDialog, Button, InlineBanner } from '@/components/ui';
import { apiResult } from '@/lib/api';

type Phase = 'idle' | 'confirming' | 'restarting' | 'restarted' | 'error';

interface Props {
  disabled?: boolean;
  disabledReason?: string;
}

/**
 * Перезапуск bridge-агента через `POST /api/v1/host/restart`.
 *
 * Подтверждение — {@link AlertDialog}, поэтому у окна наконец работают Escape
 * и ловушка фокуса. Тон обычный: перезапуск обрывает соединение на несколько
 * секунд, но ничего не удаляет, а критический цвет по §5 означает именно
 * необратимое разрушение данных.
 */
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
      const res = await apiResult<unknown>('/api/v1/host/restart', {
        method: 'POST',
        discardBody: true,
      });
      if (!res.ok) {
        setErrorText(
          res.error.status === 403
            ? 'Нет прав на эту операцию.'
            : 'Не удалось дотянуться до агента. Проверьте логи systemd.',
        );
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
      <Button
        onClick={() => setPhase('confirming')}
        disabled={disabled}
        title={disabled ? disabledReason : 'Перезапустить агент'}
      >
        Перезапустить агент
      </Button>
      {phase === 'restarted' ? (
        <span className="ml-2 text-xs text-good">Агент перезапускается. Ожидание подключения…</span>
      ) : null}

      {isModalOpen ? (
        <AlertDialog
          open
          onClose={close}
          title="Перезапустить агент?"
          tone="default"
          body={
            <>
              <p>
                Перезапустить bridge-агент? Подключение прервётся на ~3 секунды. Эту операцию нельзя
                отменить.
              </p>
              {phase === 'error' && errorText ? (
                <div className="mt-3">
                  <InlineBanner tone="crit" title={errorText} />
                </div>
              ) : null}
            </>
          }
          confirmLabel={phase === 'error' ? 'Повторить' : 'Перезапустить агент'}
          cancelLabel={phase === 'error' ? 'Закрыть' : 'Отменить'}
          busy={phase === 'restarting'}
          onConfirm={onConfirm}
        />
      ) : null}
    </>
  );
}
