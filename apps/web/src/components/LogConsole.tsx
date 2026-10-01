'use client';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { Button, InlineBanner, StatusDot } from '@/components/ui';

export interface LogEntry {
  ts?: string;
  step?: string;
  stream?: 'stdout' | 'stderr';
  message: string;
  id?: string;
}

export interface LogConsoleErrorBanner {
  code: number | null;
  reason: string | null;
  retryInMs?: number | null;
  onRetry?: () => void;
}

interface LogConsoleProps {
  lines: LogEntry[];
  /** CSS length of the log area (for example `24rem`). Defaults to 24rem. */
  height?: string;
  /** Label placed above the console. */
  title?: string;
  /** Optional "connection" indicator on the right side of the header. */
  live?: boolean;
  /** Render the step label in front of each line (used by the install wizard). */
  showStep?: boolean;
  /** Empty-state placeholder. */
  emptyText?: string;
  /** Optional connection-error banner shown above the log viewport. */
  errorBanner?: LogConsoleErrorBanner | null;
}

/**
 * Sticky-to-bottom log console.
 *
 * Rows are keyed by `LogEntry.id` when present, otherwise by the entry
 * object's identity, so callers must append new objects rather than
 * rebuilding existing ones if they want rows to stay mounted.
 *
 * Scroll behavior:
 *   - If the user is at (or within 24 px of) the bottom when a new line arrives,
 *     the console auto-scrolls to keep them pinned there.
 *   - If the user scrolls up, the console freezes — new lines are appended
 *     without jumping the view. A "↓ Latest" pill appears; clicking it scrolls
 *     to bottom and re-enables auto-stick.
 *   - `useLayoutEffect` runs the decision before the browser paints, so the
 *     viewport never flashes in the wrong place.
 */
export function LogConsole({
  lines,
  height = '24rem',
  title,
  live,
  showStep,
  emptyText = 'Нет записей',
  errorBanner,
}: LogConsoleProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const programmaticScrollRef = useRef(false);
  const [atBottom, setAtBottom] = useState(true);
  // Row keys by entry identity. Callers append parsed frames and cap their
  // buffer with `slice(-N)`, which keeps the surviving objects but shifts
  // every index — an index-based key would remount every row per new line.
  const rowKeysRef = useRef(new WeakMap<LogEntry, string>());
  const nextRowKeyRef = useRef(0);
  const rowKey = (line: LogEntry): string => {
    if (line.id) return line.id;
    let key = rowKeysRef.current.get(line);
    if (key === undefined) {
      nextRowKeyRef.current += 1;
      key = `row-${nextRowKeyRef.current}`;
      rowKeysRef.current.set(line, key);
    }
    return key;
  };

  const BOTTOM_THRESHOLD = 24;

  const onScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    if (programmaticScrollRef.current) {
      programmaticScrollRef.current = false;
      return;
    }
    const distance = el.scrollHeight - el.clientHeight - el.scrollTop;
    const pinned = distance <= BOTTOM_THRESHOLD;
    stickToBottomRef.current = pinned;
    setAtBottom(pinned);
  }, []);

  // Auto-stick: after every render that changes lines, if the user was pinned
  // at the bottom, snap to the new bottom before the browser paints. When the
  // user has scrolled up, leave the viewport alone — new lines land below the
  // fold and the "↓ к последней" pill shows up.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `lines` is the trigger, the effect only reads refs
  useLayoutEffect(() => {
    if (!stickToBottomRef.current) return;
    const el = scrollerRef.current;
    if (!el) return;
    programmaticScrollRef.current = true;
    el.scrollTop = el.scrollHeight;
  }, [lines]);

  const jumpToLatest = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    stickToBottomRef.current = true;
    programmaticScrollRef.current = true;
    el.scrollTop = el.scrollHeight;
    setAtBottom(true);
  }, []);

  return (
    <div className="relative space-y-2">
      {/* Шапка появляется только вместе с подписью: без неё индикатору связи
          не к чему прислониться, и он висел бы над консолью сам по себе. */}
      {title ? (
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-[13px] font-semibold text-ink">{title}</h2>
          {live !== undefined ? (
            <StatusDot
              state={live ? 'good' : 'idle'}
              label={live ? 'в эфире' : 'нет связи'}
              size="sm"
              pulse={live}
            />
          ) : null}
        </div>
      ) : null}
      {errorBanner ? (
        <div data-testid="logconsole-error-banner">
          <InlineBanner
            tone="crit"
            title={formatErrorBanner(errorBanner)}
            action={
              errorBanner.onRetry ? (
                <Button size="sm" onClick={errorBanner.onRetry}>
                  Переподключиться
                </Button>
              ) : undefined
            }
          />
        </div>
      ) : null}
      {/* `role="log"` — прямое назначение этой области: поток строк, который
          дописывается снизу. Программа чтения с экрана объявляет только
          прибывшее, не перечитывая всё заново, а автотесты получают опору,
          не зависящую от служебных классов. */}
      <div
        ref={scrollerRef}
        onScroll={onScroll}
        style={{ height }}
        role="log"
        aria-label={title}
        className="overflow-y-auto rounded-card border border-line bg-surface p-3 font-mono text-xs leading-relaxed"
      >
        {lines.length === 0 ? (
          <div className="text-ink-3">{emptyText}</div>
        ) : (
          lines.map((l) => {
            const key = rowKey(l);
            const isError = l.stream === 'stderr';
            return (
              <div key={key} className={isError ? 'text-crit' : 'text-ink-2'}>
                {/* Поток ошибок помечен значком и словом, а не только цветом:
                    красная строка среди серых неразличима без цветового зрения. */}
                {isError ? (
                  <>
                    <span aria-hidden="true">⚠ </span>
                    <span className="sr-only">поток ошибок: </span>
                  </>
                ) : null}
                {showStep && l.step ? <span className="text-ink-3">[{l.step}]</span> : null}
                {l.ts && !showStep ? <span className="text-ink-3">{formatTime(l.ts)} </span> : null}{' '}
                {l.message}
              </div>
            );
          })
        )}
      </div>
      {!atBottom ? (
        <Button size="sm" onClick={jumpToLatest} className="absolute right-3 bottom-3">
          ↓ к последней
        </Button>
      ) : null}
    </div>
  );
}

function formatTime(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatErrorBanner(banner: LogConsoleErrorBanner): string {
  const codeText = banner.code != null ? `код ${banner.code}` : 'неизвестный код';
  const reasonText = banner.reason ? `: ${banner.reason}` : '';
  const head = `Соединение разорвано (${codeText}${reasonText}).`;
  if (typeof banner.retryInMs === 'number' && banner.retryInMs > 0) {
    const seconds = Math.max(1, Math.ceil(banner.retryInMs / 1000));
    return `${head} Повтор через ${seconds}с…`;
  }
  return head;
}
