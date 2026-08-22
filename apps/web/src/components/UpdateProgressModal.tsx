'use client';

import { useEffect, useRef, useState } from 'react';
import { Badge, Button, Modal } from '@/components/ui';
import { LogConsole, type LogEntry } from './LogConsole';

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Path of the progress WebSocket to connect to, e.g. /api/v1/depot/progress/ws. */
  wsUrl: string;
  title: string;
  /** Called once with the terminal outcome, right before the socket closes. */
  onDone?: (final: 'done' | 'error', error?: string) => void;
}

type Status = 'connecting' | 'running' | 'done' | 'error';

const STATUS_TEXT: Record<Status, string> = {
  connecting: 'Подключение…',
  running: 'Обновление…',
  done: 'Готово',
  error: 'Ошибка обновления',
};

const STATUS_TONE = {
  connecting: 'neutral',
  running: 'accent',
  done: 'good',
  error: 'crit',
} as const;

/**
 * Watches a depot-update progress WebSocket (see apps/api/src/routes/depot.ts)
 * and streams its lines into a LogConsole until the terminal {done,final}
 * frame arrives. Reconnecting (e.g. reopening after a close) simply replays
 * the backend's buffered history, so this never needs to track state across
 * mounts itself.
 *
 * Пока обновление идёт, окно не закрывается ни Escape, ни кликом по подложке
 * (`dismissible={false}`): случайный промах мимо панели прятал бы от оператора
 * единственное место, где видно, чем кончилась операция. Явный выход остаётся —
 * крестик работает всегда, а по завершении в подвале появляется «Готово».
 */
export function UpdateProgressModal({ open, onOpenChange, wsUrl, title, onDone }: Props) {
  const [lines, setLines] = useState<LogEntry[]>([]);
  const [status, setStatus] = useState<Status>('connecting');
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: onDone is not stable across renders; intentionally only reconnects on open/wsUrl change
  useEffect(() => {
    if (!open) return;
    setLines([]);
    setStatus('connecting');
    setConnectionError(null);
    let backfillComplete = false;
    let settled = false;

    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${window.location.host}${wsUrl}`);
    wsRef.current = ws;

    ws.onopen = () => setStatus('running');
    ws.onmessage = (ev) => {
      try {
        const frame = JSON.parse(ev.data);
        if (frame.backfill_complete) {
          backfillComplete = true;
          return;
        }
        if (frame.done) {
          // A 'done' seen before backfill finished replaying history belongs
          // to a prior, already-finished run — not the one being watched now.
          if (!backfillComplete) return;
          settled = true;
          const final: 'done' | 'error' = frame.final === 'done' ? 'done' : 'error';
          setStatus(final);
          setConnectionError(null);
          onDone?.(final, frame.error);
          ws.close();
          return;
        }
        setLines((prev) => [...prev, frame as LogEntry]);
      } catch {
        // ignore malformed frame
      }
    };
    ws.onerror = () => {
      if (!settled) setConnectionError('Потеряно соединение с сервером обновления');
    };
    ws.onclose = () => {
      if (!settled) setConnectionError((prev) => prev ?? 'Соединение закрыто неожиданно');
    };

    return () => {
      wsRef.current = null;
      ws.close();
    };
  }, [open, wsUrl]);

  const finished = status === 'done' || status === 'error';

  return (
    <Modal
      open={open}
      onClose={() => onOpenChange(false)}
      title={title}
      size="lg"
      closeLabel="Закрыть"
      dismissible={finished}
      footer={
        finished ? (
          <Button variant="primary" onClick={() => onOpenChange(false)}>
            Готово
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-3">
        <p>
          <Badge tone={STATUS_TONE[status]}>{STATUS_TEXT[status]}</Badge>
        </p>
        <LogConsole
          lines={lines}
          height="20rem"
          live={status === 'running' || status === 'connecting'}
          emptyText="Ожидание первого сообщения…"
          errorBanner={connectionError ? { code: null, reason: connectionError } : null}
        />
      </div>
    </Modal>
  );
}
