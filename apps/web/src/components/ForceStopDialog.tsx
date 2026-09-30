'use client';

import { useEffect, useState } from 'react';
import { AlertDialog, InlineBanner } from '@/components/ui';

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  serverName: string;
  onConfirm: () => Promise<void>;
}

/**
 * Подтверждение принудительной остановки сервера.
 *
 * Собственная модалка из `<div>` заменена на {@link AlertDialog}: нативный
 * `<dialog>` даёт ловушку фокуса, верхний слой и Escape, которые рукописная
 * подложка воспроизводила лишь частично. Имя сервера набирается вручную —
 * остановка без сохранения выбивает из игры всех, кто на сервере сейчас, и
 * запустить её случайным попаданием по кнопке не должно быть возможно.
 *
 * Ошибку `onConfirm` показывает само окно: оно остаётся открытым, а внутри
 * появляется баннер с причиной — иначе отказ API (403/409/5xx) выглядел бы
 * как нажатие, которое ничего не сделало, хотя сервер при этом НЕ остановлен.
 *
 * @param onConfirm - Выполняет остановку; должен отклонить промис с
 *   сообщением об ошибке, если API не подтвердил её.
 */
export function ForceStopDialog({ open, onOpenChange, serverName, onConfirm }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The component stays mounted while closed, so a stale failure would
  // otherwise greet the next attempt.
  useEffect(() => {
    if (open) setError(null);
  }, [open]);

  if (!open) return null;

  async function handleConfirm() {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AlertDialog
      open
      onClose={() => onOpenChange(false)}
      title="Принудительная остановка"
      tone="destructive"
      body={
        <>
          <p>
            Сервер <strong className="font-semibold text-ink">{serverName}</strong> будет немедленно
            остановлен без сохранения. Все игроки будут отключены.
          </p>
          <p className="mt-2 text-crit">Это действие нельзя отменить.</p>
          {error ? (
            <div className="mt-3">
              <InlineBanner tone="crit" title="Сервер не остановлен" description={error} />
            </div>
          ) : null}
        </>
      }
      challenge={{
        expected: serverName,
        label: 'Введите имя сервера для подтверждения',
        hint: serverName,
      }}
      confirmLabel="Остановить принудительно"
      cancelLabel="Отмена"
      busy={busy}
      onConfirm={handleConfirm}
    />
  );
}
