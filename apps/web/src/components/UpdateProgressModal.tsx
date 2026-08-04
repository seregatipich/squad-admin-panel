'use client';

import { useEffect, useId, useRef, useState } from 'react';
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

/**
 * Watches a depot-update progress WebSocket (see apps/api/src/routes/depot.ts)
 * and streams its lines into a LogConsole until the terminal {done,final}
 * frame arrives. Reconnecting (e.g. reopening after a close) simply replays
 * the backend's buffered history, so this never needs to track state across
 * mounts itself.
 */
export function UpdateProgressModal({ open, onOpenChange, wsUrl, title, onDone }: Props) {
  const titleId = useId();
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

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onOpenChange]);

  if (!open) return null;

  const statusText =
    status === 'connecting'
      ? 'Подключение…'
      : status === 'running'
        ? 'Обновление…'
        : status === 'done'
          ? 'Готово ✓'
          : 'Ошибка обновления';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onClick={() => onOpenChange(false)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onOpenChange(false);
      }}
    >
      <div
        className="w-full max-w-2xl rounded border border-neutral-800 bg-neutral-950 p-6"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        role="document"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 id={titleId} className="text-lg font-semibold text-neutral-100">
            {title}
          </h2>
          <span
            className={
              status === 'error'
                ? 'text-sm text-red-400'
                : status === 'done'
                  ? 'text-sm text-green-400'
                  : 'text-sm text-neutral-400'
            }
          >
            {statusText}
          </span>
        </div>

        <LogConsole
          lines={lines}
          height="20rem"
          live={status === 'running' || status === 'connecting'}
          emptyText="Ожидание первого сообщения…"
          errorBanner={connectionError ? { code: null, reason: connectionError } : null}
        />

        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="rounded border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-300 hover:border-neutral-700"
          >
            Закрыть
          </button>
        </div>
      </div>
    </div>
  );
}
