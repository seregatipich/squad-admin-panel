import Link from 'next/link';
import { LogoutButton } from '@/components/LogoutButton';
import { requireSession } from '@/lib/dal';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const me = await requireSession();
  return (
    <div className="flex min-h-screen">
      <nav className="w-56 border-r border-neutral-800 p-4 space-y-1 text-sm">
        <div className="mb-6 text-xs uppercase tracking-widest text-neutral-500">
          Squad Admin Panel
        </div>
        <Link href="/dashboard" className="block rounded px-2 py-1 hover:bg-neutral-900">
          Дашборд
        </Link>
        <Link href="/servers" className="block rounded px-2 py-1 hover:bg-neutral-900">
          Серверы
        </Link>
        <Link href="/players" className="block rounded px-2 py-1 hover:bg-neutral-900">
          Игроки
        </Link>
        {me.permissions.includes('role:view') ? (
          <Link href="/roles" className="block rounded px-2 py-1 hover:bg-neutral-900">
            Роли
          </Link>
        ) : null}
        {me.permissions.includes('user:view') ? (
          <Link href="/users" className="block rounded px-2 py-1 hover:bg-neutral-900">
            Пользователи
          </Link>
        ) : null}
        <Link href="/audit" className="block rounded px-2 py-1 hover:bg-neutral-900">
          Журнал действий
        </Link>
        {me.permissions.includes('host:view') ? (
          <Link href="/logs" className="block rounded px-2 py-1 hover:bg-neutral-900">
            Логи
          </Link>
        ) : null}
        <Link href="/settings/account" className="block rounded px-2 py-1 hover:bg-neutral-900">
          Аккаунт
        </Link>
        <Link href="/settings/tokens" className="block rounded px-2 py-1 hover:bg-neutral-900">
          API-токены
        </Link>
        <div className="pt-6 text-xs text-neutral-500">
          <div className="truncate">{me.canonical_name}</div>
          <LogoutButton />
        </div>
      </nav>
      <main className="flex-1 p-8 space-y-6">{children}</main>
    </div>
  );
}
