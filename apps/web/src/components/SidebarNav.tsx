'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { LocaleSwitch } from '@/components/LocaleSwitch';
import { LogoutButton } from '@/components/LogoutButton';
import { useTranslator } from '@/i18n/LocaleProvider';
import { NAV_GROUPS, type NavItem } from '@/lib/nav';
import { useLiveSubscription } from '@/lib/use-live-bus';

function isItemActive(pathname: string, href: string | undefined): boolean {
  return href !== undefined && (pathname === href || pathname.startsWith(`${href}/`));
}

/** Filters an item's own gates, and — for a group item — its children's too, dropping children the user can't see. */
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
 * arrives, so the sidebar badge tracks the queue without polling.
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

function NavLink({
  item,
  active,
  label,
  pendingReports,
}: {
  item: NavItem;
  active: boolean;
  label: string;
  pendingReports: number;
}) {
  return (
    <Link
      href={item.href ?? '#'}
      aria-current={active ? 'page' : undefined}
      className={`relative block rounded-md px-3 py-1.5 no-underline transition-colors ${
        active
          ? 'bg-neutral-900 text-neutral-50'
          : 'text-neutral-300 hover:bg-neutral-900/60 hover:text-neutral-100'
      }`}
    >
      {active ? (
        <span aria-hidden className="absolute inset-y-1.5 left-0 w-[2px] rounded-full bg-sky-400" />
      ) : null}
      <span className="inline-flex items-center gap-1.5">
        {label}
        {item.showsPendingReports && pendingReports > 0 ? (
          <span className="rounded-full bg-amber-600 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-neutral-950">
            {pendingReports > 99 ? '99+' : pendingReports}
          </span>
        ) : null}
      </span>
    </Link>
  );
}

function NavGroupItem({
  item,
  label,
  pathname,
  t,
}: {
  item: NavItem & { children: NavItem[] };
  label: string;
  pathname: string;
  t: (key: NonNullable<NavItem['labelKey']>) => string;
}) {
  const hasActiveChild = item.children.some((child) => isItemActive(pathname, child.href));
  const [manuallyOpen, setManuallyOpen] = useState<boolean | null>(null);
  const open = manuallyOpen ?? hasActiveChild;

  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setManuallyOpen(!open)}
        className="flex w-full items-center justify-between rounded-md px-3 py-1.5 text-left text-neutral-300 transition-colors hover:bg-neutral-900/60 hover:text-neutral-100"
      >
        <span>{label}</span>
        <svg
          aria-hidden="true"
          viewBox="0 0 20 20"
          fill="none"
          className={`h-3.5 w-3.5 shrink-0 stroke-current transition-transform ${open ? 'rotate-90' : ''}`}
        >
          <path d="M7 5l6 5-6 5" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open ? (
        <div className="mt-0.5 space-y-0.5 border-l border-neutral-900 pl-2.5">
          {item.children.map((child) => (
            <NavLink
              key={child.href}
              item={child}
              active={isItemActive(pathname, child.href)}
              label={child.labelKey ? t(child.labelKey) : child.label}
              pendingReports={0}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function SidebarNav({
  permissions,
  displayName,
  economyEnabled = false,
}: {
  permissions: string[];
  displayName: string;
  /** ECON-5 (#165): items with `requiresEconomy` are hidden while false. */
  economyEnabled?: boolean;
}) {
  const pathname = usePathname() ?? '';
  const pendingReports = usePendingReportsCount();
  const t = useTranslator();

  return (
    <nav className="flex w-56 shrink-0 flex-col border-r border-neutral-900 px-3 py-5 text-sm">
      <div className="mb-6 px-2 text-[10px] font-medium uppercase tracking-[0.22em] text-neutral-500">
        {t('nav.brand')}
      </div>
      <div className="flex-1 space-y-5">
        {NAV_GROUPS.map((group, groupIndex) => {
          const visible = group.items
            .map((item) => visibleFor(item, permissions, economyEnabled))
            .filter((item): item is NavItem => item !== null);
          if (visible.length === 0) return null;
          return (
            <div key={group.label ?? `group-${groupIndex}`} className="space-y-0.5">
              {group.label ? (
                <div className="mb-1.5 px-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-neutral-600">
                  {group.labelKey ? t(group.labelKey) : group.label}
                </div>
              ) : null}
              {visible.map((item) => {
                const label = item.labelKey ? t(item.labelKey) : item.label;
                if (item.children) {
                  return (
                    <NavGroupItem
                      key={item.labelKey ?? item.label}
                      item={{ ...item, children: item.children }}
                      label={label}
                      pathname={pathname}
                      t={t}
                    />
                  );
                }
                return (
                  <NavLink
                    key={item.href}
                    item={item}
                    active={isItemActive(pathname, item.href)}
                    label={label}
                    pendingReports={pendingReports}
                  />
                );
              })}
            </div>
          );
        })}
      </div>
      <div className="mt-6 border-t border-neutral-900 px-2 pt-4 text-xs text-neutral-500">
        <div className="truncate text-neutral-400">{displayName}</div>
        <div className="mt-2 flex items-center justify-between">
          <LogoutButton />
          <LocaleSwitch className="-mr-1 flex items-center" />
        </div>
      </div>
    </nav>
  );
}
