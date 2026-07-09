'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { LogoutButton } from '@/components/LogoutButton';
import { useLiveSubscription } from '@/lib/use-live-bus';

type NavItem = { href: string; label: string; permission?: string; showsPendingReports?: boolean };
type NavGroup = { label?: string; items: NavItem[] };

const GROUPS: NavGroup[] = [
  {
    items: [{ href: '/dashboard', label: 'Дашборд' }],
  },
  {
    label: 'Серверы',
    items: [{ href: '/servers/archive', label: 'Архив', permission: 'server:view' }],
  },
  {
    label: 'Управление',
    items: [
      { href: '/players', label: 'Игроки' },
      { href: '/leaderboards', label: 'Лидерборды' },
      { href: '/clans', label: 'Кланы' },
      { href: '/matches', label: 'Матчи' },
      { href: '/events', label: 'События' },
      { href: '/combat-log', label: 'Боевой лог' },
      { href: '/votes', label: 'Голосования' },
      { href: '/chat', label: 'Чат' },
      { href: '/notes', label: 'Заметки' },
      { href: '/banned-names', label: 'Забаненные ники' },
      { href: '/issues', label: 'Тикеты' },
      { href: '/reports', label: 'Жалобы', showsPendingReports: true },
      { href: '/settings/groups', label: 'Группы', permission: 'role:view' },
      { href: '/users', label: 'Пользователи', permission: 'user:view' },
    ],
  },
  {
    label: 'Аудит',
    items: [
      { href: '/moderation/teamkills', label: 'Тимкиллы' },
      { href: '/audit', label: 'Журнал действий' },
      { href: '/logs', label: 'Логи', permission: 'host:view' },
    ],
  },
  {
    label: 'Настройки',
    items: [
      { href: '/settings/account', label: 'Аккаунт' },
      { href: '/settings/message-templates', label: 'Шаблоны сообщений', permission: 'role:edit' },
      { href: '/settings/mark-types', label: 'Типы меток', permission: 'role:edit' },
      { href: '/settings/chat-flags', label: 'Флаги чата', permission: 'role:edit' },
      { href: '/settings/alerts', label: 'Оповещения' },
      { href: '/settings/economy', label: 'Экономика' },
      { href: '/settings/tokens', label: 'API-токены' },
      { href: '/settings/ban-sources', label: 'Источники банов' },
      {
        href: '/settings/integrations/discord',
        label: 'Discord',
        permission: 'integration:manage',
      },
      {
        href: '/settings/integrations/geoip',
        label: 'GeoIP (MaxMind)',
        permission: 'integration:manage',
      },
    ],
  },
];

function isItemActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
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

export function SidebarNav({
  permissions,
  displayName,
}: {
  permissions: string[];
  displayName: string;
}) {
  const pathname = usePathname() ?? '';
  const pendingReports = usePendingReportsCount();

  return (
    <nav className="flex w-56 shrink-0 flex-col border-r border-neutral-900 px-3 py-5 text-sm">
      <div className="mb-6 px-2 text-[10px] font-medium uppercase tracking-[0.22em] text-neutral-500">
        Squad Admin Panel
      </div>
      <div className="flex-1 space-y-5">
        {GROUPS.map((group, groupIndex) => {
          const visible = group.items.filter(
            (item) => !item.permission || permissions.includes(item.permission),
          );
          if (visible.length === 0) return null;
          return (
            <div key={group.label ?? `group-${groupIndex}`} className="space-y-0.5">
              {group.label ? (
                <div className="mb-1.5 px-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-neutral-600">
                  {group.label}
                </div>
              ) : null}
              {visible.map((item) => {
                const active = isItemActive(pathname, item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={active ? 'page' : undefined}
                    className={`relative block rounded-md px-3 py-1.5 no-underline transition-colors ${
                      active
                        ? 'bg-neutral-900 text-neutral-50'
                        : 'text-neutral-300 hover:bg-neutral-900/60 hover:text-neutral-100'
                    }`}
                  >
                    {active ? (
                      <span
                        aria-hidden
                        className="absolute inset-y-1.5 left-0 w-[2px] rounded-full bg-sky-400"
                      />
                    ) : null}
                    <span className="inline-flex items-center gap-1.5">
                      {item.label}
                      {item.showsPendingReports && pendingReports > 0 ? (
                        <span className="rounded-full bg-amber-600 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-neutral-950">
                          {pendingReports > 99 ? '99+' : pendingReports}
                        </span>
                      ) : null}
                    </span>
                  </Link>
                );
              })}
            </div>
          );
        })}
      </div>
      <div className="mt-6 border-t border-neutral-900 px-2 pt-4 text-xs text-neutral-500">
        <div className="truncate text-neutral-400">{displayName}</div>
        <LogoutButton />
      </div>
    </nav>
  );
}
