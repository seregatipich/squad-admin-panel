'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { LocaleSwitch } from '@/components/LocaleSwitch';
import { LogoutButton } from '@/components/LogoutButton';
import { useTranslator } from '@/i18n/LocaleProvider';
import type { Translator } from '@/i18n/translate';
import { openCommandPalette } from '@/lib/commandPalette';
import { activeNavGroupLabel, isNavHrefActive, type NavGroup, type NavItem } from '@/lib/nav';
import { useLiveSubscription } from '@/lib/use-live-bus';

/** Filters an item's own gates, and — for a menu column — its children's too. */
function visibleFor(item: NavItem, permissions: string[], economyEnabled: boolean): NavItem | null {
  const allowed =
    (!item.permission || permissions.includes(item.permission)) &&
    (!item.requiresEconomy || economyEnabled);
  if (!allowed) return null;
  if (!item.children) return item;
  const children = item.children
    .map((child) => visibleFor(child, permissions, economyEnabled))
    .filter((child): child is NavItem => child !== null);
  return children.length > 0 ? { ...item, children } : null;
}

/**
 * Number of reports still awaiting moderation. Fetched once on mount and
 * refreshed whenever a `report.created`/`report.updated` live-bus event
 * arrives, so the badge tracks the queue without polling.
 */
function usePendingReportsCount(): number {
  const [count, setCount] = useState(0);

  const refresh = useCallback(() => {
    fetch('/api/v1/reports?status=pending&page=1&page_size=1', {
      credentials: 'include',
      cache: 'no-store',
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { total?: number } | null) => setCount(data?.total ?? 0))
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);
  useLiveSubscription('report.created', refresh);
  useLiveSubscription('report.updated', refresh);

  return count;
}

/** Whether any page inside `group` carries the pending-reports badge. */
function groupShowsPendingReports(group: NavGroup): boolean {
  return group.items.some(
    (item) => item.showsPendingReports || item.children?.some((c) => c.showsPendingReports),
  );
}

function PendingBadge({ count, label }: { count: number; label: string }) {
  return (
    <span
      title={label}
      className="rounded-full bg-warn px-1.5 py-px font-mono text-2xs font-semibold leading-none text-bg"
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}

function MenuLink({
  item,
  active,
  pendingReports,
  t,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  pendingReports: number;
  t: Translator;
  onNavigate: () => void;
}) {
  return (
    <Link
      href={item.href ?? '#'}
      aria-current={active ? 'page' : undefined}
      onClick={onNavigate}
      className={`block rounded-ctl px-2 py-1.5 no-underline transition-colors ${
        active ? 'bg-accent-dim text-ink' : 'text-ink-2 hover:bg-raised hover:text-ink'
      }`}
    >
      <span className="flex items-center gap-1.5 text-xs">
        {item.labelKey ? t(item.labelKey) : item.label}
        {item.showsPendingReports && pendingReports > 0 && (
          <PendingBadge
            count={pendingReports}
            label={t('nav.pendingReports', { count: pendingReports })}
          />
        )}
      </span>
      {item.hintKey && <span className="block text-2xs text-ink-3">{t(item.hintKey)}</span>}
    </Link>
  );
}

/**
 * The panel's global navigation: a sticky top bar with dropdown menus.
 *
 * There is no left sidebar. A sidebar spends a fixed column of every screen on
 * links that are read once per session; on a panel whose main job is wide
 * tables of players, matches and log lines, that column is the most expensive
 * real estate in the app. The same tree fits in a 46px bar and every page gets
 * the full window width.
 *
 * Menus open on click rather than hover, so a pointer crossing the bar on its
 * way somewhere else never covers the page, and close on Escape, an outside
 * click, or navigating.
 */
export function TopNav({
  permissions,
  displayName,
  groups,
  economyEnabled = false,
}: {
  permissions: string[];
  displayName: string;
  /** Navigation tree; defaults to the panel's own {@link NAV_GROUPS}. */
  groups: NavGroup[];
  /** ECON-5 (#165): items with `requiresEconomy` are hidden while false. */
  economyEnabled?: boolean;
}) {
  const pathname = usePathname() ?? '';
  const pendingReports = usePendingReportsCount();
  const t = useTranslator();
  const [open, setOpen] = useState<string | null>(null);
  const [lastPath, setLastPath] = useState(pathname);
  const barRef = useRef<HTMLElement>(null);
  const activeGroup = activeNavGroupLabel(pathname, groups);

  // Navigating closes whatever menu was open. Adjusted during render rather
  // than in an effect, so the menu never paints once on the new page.
  if (lastPath !== pathname) {
    setLastPath(pathname);
    setOpen(null);
  }

  useEffect(() => {
    if (!open) return;

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(null);
    };
    const onPointer = (event: MouseEvent) => {
      if (!barRef.current?.contains(event.target as Node)) setOpen(null);
    };

    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointer);
    };
  }, [open]);

  return (
    <nav
      ref={barRef}
      aria-label={t('nav.mainNav')}
      className="sticky top-0 z-40 border-b border-line bg-surface/80 backdrop-blur-xl"
    >
      <div className="flex h-[46px] items-center gap-1 px-3">
        <ul className="flex min-w-0 items-center gap-0.5 overflow-x-auto">
          {groups.map((group, groupIndex) => {
            const visible = group.items
              .map((item) => visibleFor(item, permissions, economyEnabled))
              .filter((item): item is NavItem => item !== null);
            if (visible.length === 0) return null;

            // An unlabeled group has no menu of its own — its items sit
            // directly in the bar (the dashboard is the only one today).
            if (!group.label) {
              return visible.map((item) => (
                <li key={item.href}>
                  <Link
                    href={item.href ?? '#'}
                    aria-current={isNavHrefActive(pathname, item.href) ? 'page' : undefined}
                    className={`block whitespace-nowrap rounded-ctl px-2.5 py-1.5 text-xs no-underline transition-colors ${
                      isNavHrefActive(pathname, item.href)
                        ? 'bg-raised text-ink'
                        : 'text-ink-2 hover:bg-raised/60 hover:text-ink'
                    }`}
                  >
                    {item.labelKey ? t(item.labelKey) : item.label}
                  </Link>
                </li>
              ));
            }

            const label = group.labelKey ? t(group.labelKey) : group.label;
            const isOpen = open === group.label;
            const isActive = activeGroup === group.label;
            const columns = visible.filter((item) => item.children);
            const wide = columns.length > 1;
            const badgeOnTrigger =
              !isOpen &&
              pendingReports > 0 &&
              groupShowsPendingReports({ ...group, items: visible });

            return (
              <li
                key={group.label ?? `group-${groupIndex}`}
                className={wide ? undefined : 'relative'}
              >
                <button
                  type="button"
                  aria-expanded={isOpen}
                  aria-haspopup="true"
                  onClick={() => setOpen(isOpen ? null : (group.label ?? null))}
                  className={`flex items-center gap-1 whitespace-nowrap rounded-ctl px-2.5 py-1.5 text-xs transition-colors ${
                    isActive || isOpen
                      ? 'bg-raised text-ink'
                      : 'text-ink-2 hover:bg-raised/60 hover:text-ink'
                  }`}
                >
                  {label}
                  {badgeOnTrigger && (
                    <PendingBadge
                      count={pendingReports}
                      label={t('nav.pendingReports', { count: pendingReports })}
                    />
                  )}
                  <span aria-hidden className="text-[8px] text-ink-3">
                    ▾
                  </span>
                </button>

                {isOpen && (
                  <div
                    // A mega-menu is anchored to the bar rather than to its
                    // trigger: four columns hanging off the rightmost button
                    // would run past the window edge.
                    className={`absolute z-50 rounded-card border border-line-2 bg-surface p-2 shadow-2xl shadow-black/50 ${
                      wide
                        ? 'left-3 right-3 top-[calc(100%+4px)] grid grid-cols-2 gap-x-1 lg:grid-cols-4'
                        : 'left-0 top-[calc(100%+4px)] w-60'
                    }`}
                  >
                    {wide ? (
                      columns.map((column) => (
                        <div key={column.label}>
                          <p className="px-2 pb-1 pt-2 font-mono text-2xs uppercase tracking-[0.13em] text-ink-3">
                            {column.labelKey ? t(column.labelKey) : column.label}
                          </p>
                          <ul>
                            {(column.children ?? []).map((child) => (
                              <li key={child.href}>
                                <MenuLink
                                  item={child}
                                  active={isNavHrefActive(pathname, child.href)}
                                  pendingReports={pendingReports}
                                  t={t}
                                  onNavigate={() => setOpen(null)}
                                />
                              </li>
                            ))}
                          </ul>
                        </div>
                      ))
                    ) : (
                      <ul>
                        {visible.map((item) => (
                          <li key={item.href}>
                            <MenuLink
                              item={item}
                              active={isNavHrefActive(pathname, item.href)}
                              pendingReports={pendingReports}
                              t={t}
                              onNavigate={() => setOpen(null)}
                            />
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={openCommandPalette}
            className="flex h-7 w-[220px] items-center gap-2 rounded-ctl border border-line-2 bg-bg px-2 text-xs text-ink-3 hover:border-ink-3 max-lg:w-9 max-lg:justify-center"
          >
            <span aria-hidden>⌕</span>
            <span className="max-lg:hidden">{t('nav.search')}</span>
            <kbd className="ml-auto rounded border border-line-2 px-1 font-mono text-[10px] max-lg:hidden">
              ⌘K
            </kbd>
          </button>

          <UserMenu displayName={displayName} t={t} />
        </div>
      </div>
    </nav>
  );
}

function UserMenu({ displayName, t }: { displayName: string; t: Translator }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-label={t('nav.userMenu')}
        onClick={() => setOpen(!open)}
        className="flex h-7 items-center gap-2 rounded-ctl border border-line-2 px-1.5 text-xs text-ink-2 hover:border-ink-3"
      >
        <span
          aria-hidden
          className="grid size-[18px] place-items-center rounded-full bg-raised text-[10px]"
        >
          {displayName.slice(0, 1).toUpperCase()}
        </span>
        <span className="max-sm:hidden">{displayName}</span>
        <span aria-hidden className="text-[8px] text-ink-3">
          ▾
        </span>
      </button>

      {open && (
        <div className="absolute right-0 top-[calc(100%+4px)] z-50 w-52 rounded-card border border-line-2 bg-surface p-2 shadow-2xl shadow-black/50">
          <p className="truncate px-2 pb-2 pt-1 text-xs text-ink">{displayName}</p>
          <Link
            href="/settings/account"
            onClick={() => setOpen(false)}
            className="block rounded-ctl px-2 py-1.5 text-xs text-ink-2 no-underline hover:bg-raised hover:text-ink"
          >
            {t('nav.account')}
          </Link>
          <Link
            href="/settings/tokens"
            onClick={() => setOpen(false)}
            className="block rounded-ctl px-2 py-1.5 text-xs text-ink-2 no-underline hover:bg-raised hover:text-ink"
          >
            {t('nav.tokens')}
          </Link>
          <div className="mt-1 flex items-center justify-between border-t border-line px-2 pt-1.5 text-xs">
            <LogoutButton />
            <LocaleSwitch className="-mr-1 flex items-center" />
          </div>
        </div>
      )}
    </div>
  );
}
