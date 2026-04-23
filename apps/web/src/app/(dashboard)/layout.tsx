import Link from 'next/link';
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
        <Link href="/audit" className="block rounded px-2 py-1 hover:bg-neutral-900">
          Журнал действий
        </Link>
        <Link href="/settings/account" className="block rounded px-2 py-1 hover:bg-neutral-900">
          Аккаунт
        </Link>
        <div className="pt-6 text-xs text-neutral-500">
          <div className="truncate">{me.display_name ?? me.email}</div>
          <form action="/api/v1/auth/logout" method="post">
            <button type="submit" className="mt-1 text-red-400 hover:text-red-300">
              Выйти
            </button>
          </form>
        </div>
      </nav>
      <main className="flex-1 p-8 space-y-6">{children}</main>
    </div>
  );
}
