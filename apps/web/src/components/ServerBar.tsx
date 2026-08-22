'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslator } from '@/i18n/LocaleProvider';
import { useLiveSubscription } from '@/lib/use-live-bus';

interface ServerChip {
  id: string;
  display_name: string;
  status: string;
  player_count: number | null;
}

/** Paths where the server switcher is context rather than clutter. */
const CONTEXT_PREFIXES = ['/dashboard', '/servers', '/statistics', '/matches', '/chat'];

const STATUS_DOT: Record<string, string> = {
  running: 'bg-good',
  starting: 'bg-warn',
  stopping: 'bg-warn',
  installing: 'bg-warn',
  updating: 'bg-warn',
  failed: 'bg-crit',
  stopped: 'bg-ink-3',
  pending: 'bg-ink-3',
  ready: 'bg-ink-3',
};

/**
 * The server switcher: every server as a chip carrying its live occupancy.
 *
 * On a multi-server panel "which server am I looking at, and where are the
 * players right now" is asked on every screen, so the answer sits above the
 * content instead of inside one card on one page. It is shown only on the
 * pages where a server is the subject — {@link CONTEXT_PREFIXES}.
 *
 * The player count is whatever the RCON poller last wrote to Redis; a server
 * that has never been polled shows no number rather than a misleading zero.
 */
export function ServerBar() {
  const pathname = usePathname() ?? '';
  const t = useTranslator();
  const [servers, setServers] = useState<ServerChip[]>([]);
  const barRef = useRef<HTMLElement>(null);

  const inContext = CONTEXT_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );

  const refresh = useCallback(() => {
    fetch('/api/v1/servers', { credentials: 'include', cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { items?: ServerChip[] } | null) => setServers(data?.items ?? []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!inContext) return;
    refresh();
  }, [inContext, refresh]);
  useLiveSubscription('server.status', refresh);
  useLiveSubscription('server.deleted', refresh);
  useLiveSubscription('rcon.status', refresh);

  // Высота всей прилипающей хромы публикуется в `--chrome-h`, а не считается
  // на месте: полоса серверов переносится на вторую строку, когда серверов
  // много, поэтому её высота не константа. Липкие шапки таблиц отсчитываются
  // от этой переменной и без неё уезжали бы под полосу.
  useLayoutEffect(() => {
    const root = document.documentElement;
    const bar = barRef.current;
    if (!bar) {
      root.style.removeProperty('--chrome-h');
      return;
    }
    const apply = () => {
      root.style.setProperty('--chrome-h', `calc(var(--nav-h) + ${bar.offsetHeight}px)`);
    };
    apply();
    // Эффект и так пересчитывает высоту на каждый рендер, поэтому наблюдатель
    // нужен только для переносов строки при изменении ширины окна. В jsdom его
    // нет, и это не повод падать.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(apply);
    observer?.observe(bar);
    return () => {
      observer?.disconnect();
      root.style.removeProperty('--chrome-h');
    };
  });

  // Nothing to switch between, or nothing to switch on: render no strip at all
  // rather than an empty bar that costs a row of vertical space.
  if (!inContext || servers.length === 0) return null;

  return (
    <nav
      ref={barRef}
      aria-label={t('nav.serverSwitcher')}
      // Прилипает под верхней панелью: «какой сервер и сколько на нём людей» —
      // вопрос, который оператор задаёт на каждом экране, а не один раз при
      // загрузке страницы, поэтому ответ не должен уезжать вверх при прокрутке.
      className="sticky top-[var(--nav-h)] z-30 border-b border-line bg-bg/85 backdrop-blur-xl"
    >
      <ul className="flex flex-wrap items-stretch gap-1.5 px-3 py-2">
        {servers.map((server) => {
          const isActive = pathname.startsWith(`/servers/${server.id}`);
          return (
            <li key={server.id}>
              <Link
                href={`/servers/${server.id}`}
                aria-current={isActive ? 'page' : undefined}
                className={`flex h-9 items-center gap-2 rounded-card border px-2.5 no-underline transition-colors ${
                  isActive
                    ? 'border-accent/50 bg-accent-dim'
                    : 'border-line bg-surface hover:border-line-2'
                }`}
              >
                <span
                  aria-hidden
                  className={`size-1.5 shrink-0 rounded-full ${STATUS_DOT[server.status] ?? 'bg-ink-3'}`}
                />
                <span className="text-xs text-ink">{server.display_name}</span>
                {server.player_count !== null && (
                  <span className="font-mono text-2xs tabular text-ink-3">
                    {server.player_count}
                  </span>
                )}
              </Link>
            </li>
          );
        })}
        <li>
          <Link
            href="/servers/new"
            className="flex h-9 items-center gap-1.5 rounded-card border border-dashed border-line-2 px-2.5 text-xs text-ink-3 no-underline hover:border-accent hover:text-accent"
          >
            + {t('nav.addServer')}
          </Link>
        </li>
      </ul>
    </nav>
  );
}
