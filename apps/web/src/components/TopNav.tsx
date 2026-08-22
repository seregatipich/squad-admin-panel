'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { LocaleSwitch } from '@/components/LocaleSwitch';
import { logout } from '@/components/LogoutButton';
import { SearchIcon } from '@/components/ui/icons';
import { Menu, type MenuItem } from '@/components/ui/Menu';
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

/** Context every nav item needs to become a menu item. */
interface ItemContext {
  pathname: string;
  pendingReports: number;
  t: Translator;
}

function toMenuLink(item: NavItem, ctx: ItemContext): MenuItem {
  const label = item.labelKey ? ctx.t(item.labelKey) : item.label;
  return {
    kind: 'link',
    href: item.href ?? '#',
    label,
    hint: item.hintKey ? ctx.t(item.hintKey) : undefined,
    active: isNavHrefActive(ctx.pathname, item.href),
    badge:
      item.showsPendingReports && ctx.pendingReports > 0 ? (
        <PendingBadge
          count={ctx.pendingReports}
          label={ctx.t('nav.pendingReports', { count: ctx.pendingReports })}
        />
      ) : undefined,
  };
}

/** A nav item is either a page (one menu item) or a column of pages (a group). */
function toMenuItems(items: NavItem[], ctx: ItemContext): MenuItem[] {
  return items.map((item) =>
    item.children
      ? {
          kind: 'group' as const,
          label: item.labelKey ? ctx.t(item.labelKey) : item.label,
          items: item.children.map((child) => toMenuLink(child, ctx)),
        }
      : toMenuLink(item, ctx),
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
 * Menus are {@link Menu}, so each one is a real `role="menu"`: arrow keys walk
 * it, Home/End jump to its ends, a typed letter finds an item, Escape closes it
 * and returns focus to the trigger. They open on click rather than hover, so a
 * pointer crossing the bar on its way somewhere else never covers the page.
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
  const activeGroup = activeNavGroupLabel(pathname, groups);
  const ctx: ItemContext = { pathname, pendingReports, t };

  // Navigating closes whatever menu was open. Adjusted during render rather
  // than in an effect, so the menu never paints once on the new page.
  if (lastPath !== pathname) {
    setLastPath(pathname);
    setOpen(null);
  }

  return (
    <nav
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
                    className={`flex h-8 items-center whitespace-nowrap rounded-ctl px-2.5 text-xs no-underline transition-colors duration-150 ${
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

            const isOpen = open === group.label;
            const columnCount = visible.filter((item) => item.children).length;
            const badgeOnTrigger =
              !isOpen &&
              pendingReports > 0 &&
              groupShowsPendingReports({ ...group, items: visible });

            return (
              <li key={group.label ?? `group-${groupIndex}`}>
                <Menu
                  trigger={{
                    label: group.labelKey ? t(group.labelKey) : group.label,
                    active: activeGroup === group.label,
                    badge: badgeOnTrigger ? (
                      <PendingBadge
                        count={pendingReports}
                        label={t('nav.pendingReports', { count: pendingReports })}
                      />
                    ) : undefined,
                  }}
                  items={toMenuItems(visible, ctx)}
                  open={isOpen}
                  onOpenChange={(next) => setOpen(next ? (group.label ?? null) : null)}
                  columns={columnCount > 1 ? 2 : 1}
                />
              </li>
            );
          })}
        </ul>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={openCommandPalette}
            className="flex h-8 w-[220px] items-center gap-2 rounded-ctl border border-line-2 bg-bg px-2 text-xs text-ink-3 transition-colors duration-150 hover:border-ink-3 max-lg:w-9 max-lg:justify-center"
          >
            <SearchIcon className="size-3.5" />
            <span className="max-lg:hidden">{t('nav.search')}</span>
            <kbd className="ml-auto rounded border border-line-2 px-1 font-mono text-2xs max-lg:hidden">
              ⌘K
            </kbd>
          </button>

          {/* The language toggle is a control, not a command, so it lives in the
              bar rather than inside the user menu, whose children have to be
              menu items for the menu to stay a menu. */}
          <LocaleSwitch />

          <UserMenu displayName={displayName} t={t} />
        </div>
      </div>
    </nav>
  );
}

function UserMenu({ displayName, t }: { displayName: string; t: Translator }) {
  const [open, setOpen] = useState(false);

  return (
    <Menu
      align="end"
      open={open}
      onOpenChange={setOpen}
      trigger={{
        ariaLabel: t('nav.userMenu'),
        label: (
          <span className="flex items-center gap-2">
            <span
              aria-hidden
              className="grid size-[18px] place-items-center rounded-full bg-raised text-2xs"
            >
              {displayName.slice(0, 1).toUpperCase()}
            </span>
            <span className="max-sm:hidden">{displayName}</span>
          </span>
        ),
      }}
      items={[
        { kind: 'link', href: '/settings/account', label: t('nav.account') },
        { kind: 'link', href: '/settings/tokens', label: t('nav.tokens') },
        { kind: 'separator' },
        { kind: 'action', label: t('nav.logout'), onSelect: () => void logout() },
      ]}
    />
  );
}
