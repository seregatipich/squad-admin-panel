'use client';

import { useState } from 'react';
import { AlertDialog } from '@/components/ui';

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
 */
export function ForceStopDialog({ open, onOpenChange, serverName, onConfirm }: Props) {
  const [busy, setBusy] = useState(false);

  if (!open) return null;

  async function handleConfirm() {
    setBusy(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch {
      // caller handles error
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
