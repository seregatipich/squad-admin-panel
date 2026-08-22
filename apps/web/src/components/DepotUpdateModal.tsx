'use client';

import { useState } from 'react';
import { Button, Checkbox, EmptyState, Modal } from '@/components/ui';

interface ServerEntry {
  id: string;
  display_name: string;
  status: string;
  player_count: number;
}

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  servers: ServerEntry[];
  onStart: (serverIds: string[]) => Promise<void>;
}

/**
 * Выбор серверов, которые будут остановлены на время обновления Squad.
 *
 * Окно остаётся смонтированным и закрытым (`open={false}`), а не исчезает из
 * разметки: тогда нативный `<dialog>` сам возвращает фокус на кнопку, которая
 * его открыла. Пока запрос на запуск обновления идёт, окно не закрывается ни
 * Escape, ни кликом по подложке.
 */
export function DepotUpdateModal({ open, onOpenChange, servers, onStart }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const runnableServers = servers.filter((s) => ['running', 'starting'].includes(s.status));

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleStart() {
    setBusy(true);
    try {
      await onStart(Array.from(selected));
      onOpenChange(false);
    } catch {
      // caller handles
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => onOpenChange(false)}
      title="Обновить Squad"
      description={
        runnableServers.length > 0
          ? 'Отмеченные серверы будут остановлены на время обновления (~10 мин).'
          : undefined
      }
      closeLabel="Закрыть"
      dismissible={!busy}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
            Отмена
          </Button>
          <Button variant="primary" onClick={() => void handleStart()} loading={busy}>
            Начать обновление
          </Button>
        </>
      }
    >
      {runnableServers.length > 0 ? (
        <ul className="divide-y divide-line rounded-ctl border border-line">
          {runnableServers.map((s) => (
            <li key={s.id} className="flex items-center gap-3 px-3 py-2">
              <Checkbox
                label={s.display_name}
                checked={selected.has(s.id)}
                onChange={() => toggle(s.id)}
                className="min-w-0 flex-1"
              />
              <span className="shrink-0 text-xs tabular-nums text-ink-3">
                {s.player_count} {s.player_count === 1 ? 'игрок' : 'игроков'}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState
          title="Нет запущенных серверов"
          description="Останавливать нечего: обновление начнётся сразу."
        />
      )}
    </Modal>
  );
}
