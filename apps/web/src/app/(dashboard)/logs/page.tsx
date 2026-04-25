import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { LogList, type ServersResponse } from '@/components/LogList';
import { apiFetch } from '@/lib/api';
import { requireSession, SESSION_COOKIE } from '@/lib/dal';

export const dynamic = 'force-dynamic';

export default async function LogsPage() {
  const me = await requireSession();
  if (!me.permissions.includes('host:view')) {
    redirect('/dashboard');
  }
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  let servers: ServersResponse['items'] = [];
  try {
    const data = await apiFetch<ServersResponse>('/api/v1/servers', {
      cookie: token ? `${SESSION_COOKIE}=${token}` : '',
    });
    servers = data.items ?? [];
  } catch {
    servers = [];
  }
  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
        <h1 className="text-lg font-semibold">Логи</h1>
        <p className="text-xs text-neutral-500">
          Последние 1000 записей из всех коннекторов панели. Обновление в реальном времени.
        </p>
      </div>
      <LogList servers={servers} />
    </div>
  );
}
