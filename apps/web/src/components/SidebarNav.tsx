'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LogoutButton } from '@/components/LogoutButton';

type NavItem = { href: string; label: string; permission?: string };
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
      { href: '/matches', label: 'Матчи' },
      { href: '/banned-names', label: 'Забаненные ники' },
      { href: '/issues', label: 'Тикеты' },
      { href: '/settings/groups', label: 'Группы', permission: 'role:view' },
      { href: '/users', label: 'Пользователи', permission: 'user:view' },
    ],
  },
  {
    label: 'Аудит',
    items: [
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
      { href: '/settings/tokens', label: 'API-токены' },
      { href: '/settings/ban-sources', label: 'Источники банов' },
      {
        href: '/settings/integrations/discord',
        label: 'Discord',
        permission: 'integration:manage',
      },
    ],
  },
];

function isItemActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function SidebarNav({
  permissions,
  displayName,
}: {
  permissions: string[];
  displayName: string;
}) {
  const pathname = usePathname() ?? '';

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
                    {item.label}
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
