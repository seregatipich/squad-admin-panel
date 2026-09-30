'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslator } from '@/i18n/LocaleProvider';
import type { LiveEvent } from '@/lib/live-bus';
import { useLiveSubscription } from '@/lib/use-live-bus';

interface ServerChip {
  id: string;
  display_name: string;
  status: string;
  player_count: number | null;
}

/** Paths where the server switcher is context rather than clutter. */
const CONTEXT_PREFIXES = ['/dashboard', '/servers', '/statistics', '/matches', '/chat'];

/**
 * Quiet period before a live status event refetches the list, so a burst
 * (a restart walks through several states; a bulk delete emits one event per
 * server) costs one `GET /api/v1/servers` instead of one per event.
 */
const REFRESH_DEBOUNCE_MS = 500;

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
 *
 * Live updates are cheap on purpose, because the bar is mounted in the shared
 * layout of every page: events are ignored where the bar is hidden,
 * `rcon.status` (emitted on nearly every poll) patches the count in place,
 * and `server.status`/`server.deleted` refetch once per burst, with each new
 * request aborting the previous one so an older response never lands last.
 */
export function ServerBar() {
  const pathname = usePathname() ?? '';
  const t = useTranslator();
  const [servers, setServers] = useState<ServerChip[]>([]);
  const barRef = useRef<HTMLElement>(null);

  const inContext = CONTEXT_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );

  const inContextRef = useRef(inContext);
  inContextRef.current = inContext;
  const requestRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(() => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    fetch('/api/v1/servers', {
      credentials: 'include',
      cache: 'no-store',
      signal: controller.signal,
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { items?: ServerChip[] } | null) => {
        if (controller.signal.aborted) return;
        setServers(data?.items ?? []);
      })
      .catch(() => {});
  }, []);

  const scheduleRefresh = useCallback(() => {
    if (!inContextRef.current) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      refresh();
    }, REFRESH_DEBOUNCE_MS);
  }, [refresh]);

  const onRconStatus = useCallback((event: Extract<LiveEvent, { type: 'rcon.status' }>) => {
    if (!inContextRef.current) return;
    const { server_id: serverId, player_count: playerCount } = event.data;
    if (playerCount === undefined) return;
    setServers((prev) =>
      prev.map((server) =>
        server.id === serverId ? { ...server, player_count: playerCount } : server,
      ),
    );
  }, []);

  useEffect(() => {
    if (!inContext) return;
    refresh();
  }, [inContext, refresh]);
  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      requestRef.current?.abort();
    },
    [],
  );
  useLiveSubscription('server.status', scheduleRefresh);
  useLiveSubscription('server.deleted', scheduleRefresh);
  useLiveSubscription('rcon.status', onRconStatus);

  // Высота всей прилипающей хромы публикуется в `--chrome-h`, а не считается
  // на месте: полоса серверов переносится на вторую строку, когда серверов
  // много, поэтому её высота не константа. Липкие шапки таблиц отсчитываются
  // от этой переменной и без неё уезжали бы под полосу.
  const hasBar = inContext && servers.length > 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `hasBar` decides whether `barRef` is mounted.
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
    // Наблюдатель следит за переносами строки при смене ширины окна и числа
    // серверов. В jsdom его нет, и это не повод падать.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(apply);
    observer?.observe(bar);
    return () => {
      observer?.disconnect();
      root.style.removeProperty('--chrome-h');
    };
  }, [hasBar]);

  // Nothing to switch between, or nothing to switch on: render no strip at all
  // rather than an empty bar that costs a row of vertical space.
  if (!hasBar) return null;

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
