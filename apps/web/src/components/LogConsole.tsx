'use client';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';

export interface LogEntry {
  ts?: string;
  step?: string;
  stream?: 'stdout' | 'stderr';
  message: string;
  id?: string;
}

interface LogConsoleProps {
  lines: LogEntry[];
  /** Visual height; number of pixels. Defaults to 24rem. */
  height?: string;
  /** Label placed above the console. */
  title?: string;
  /** Optional "connection" indicator on the right side of the header. */
  live?: boolean;
  /** Render the step label in front of each line (used by the install wizard). */
  showStep?: boolean;
  /** Empty-state placeholder. */
  emptyText?: string;
}

/**
 * Sticky-to-bottom log console.
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
}: LogConsoleProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const programmaticScrollRef = useRef(false);
  const [atBottom, setAtBottom] = useState(true);

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
    <div className="relative space-y-1">
      {title ? (
        <div className="flex items-center justify-between">
          <h2 className="text-xs uppercase tracking-widest text-neutral-400">{title}</h2>
          {live !== undefined ? (
            <span className="flex items-center gap-1 text-xs text-neutral-500">
              <span
                className={`inline-block h-2 w-2 rounded-full ${live ? 'bg-green-600' : 'bg-neutral-600'}`}
              />
              {live ? 'live' : 'offline'}
            </span>
          ) : null}
        </div>
      ) : null}
      <div
        ref={scrollerRef}
        onScroll={onScroll}
        style={{ height }}
        className="overflow-y-auto rounded border border-neutral-800 bg-neutral-950 p-3 font-mono text-xs leading-relaxed"
      >
        {lines.length === 0 ? (
          <div className="text-neutral-600">{emptyText}</div>
        ) : (
          lines.map((l, i) => {
            const key = l.id ?? `${l.ts ?? ''}:${i}:${l.message.slice(0, 40)}`;
            return (
              <div
                key={key}
                className={l.stream === 'stderr' ? 'text-red-400' : 'text-neutral-300'}
              >
                {showStep && l.step ? <span className="text-neutral-500">[{l.step}]</span> : null}
                {l.ts && !showStep ? (
                  <span className="text-neutral-600">{formatTime(l.ts)} </span>
                ) : null}{' '}
                {l.message}
              </div>
            );
          })
        )}
      </div>
      {!atBottom ? (
        <button
          type="button"
          onClick={jumpToLatest}
          className="absolute bottom-3 right-3 rounded-full bg-sky-600 px-3 py-1 text-xs text-white shadow hover:bg-sky-500"
        >
          ↓ к последней
        </button>
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
