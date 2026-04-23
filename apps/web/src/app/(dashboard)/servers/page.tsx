import { cookies } from 'next/headers';
import Link from 'next/link';
import { apiFetch } from '@/lib/api';
import { SESSION_COOKIE } from '@/lib/dal';

interface Server {
  id: string;
  display_name: string;
  slug: string;
  status: string;
  created_at: string;
}

export default async function ServersPage() {
  const jar = await cookies();
  const cookie = `${SESSION_COOKIE}=${jar.get(SESSION_COOKIE)?.value ?? ''}`;
  const data = await apiFetch<{ items: Server[]; total: number }>('/api/v1/servers', { cookie });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Серверы</h1>
        <Link
          href="/servers/new"
          className="rounded bg-sky-600 px-3 py-1.5 text-sm text-white hover:bg-sky-500"
        >
          + Установить новый
        </Link>
      </div>
      {data.items.length === 0 ? (
        <div className="rounded border border-neutral-800 bg-neutral-950 p-6 text-center text-neutral-500">
          Нет серверов. Нажмите «Установить новый» чтобы добавить.
        </div>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-xs uppercase tracking-widest text-neutral-500">
            <tr>
              <th className="text-left p-2">Имя</th>
              <th className="text-left p-2">Статус</th>
              <th className="text-left p-2">Slug</th>
              <th className="text-left p-2">Создан</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((row) => (
              <tr key={row.id} className="border-t border-neutral-900">
                <td className="p-2">
                  <Link href={`/servers/${row.id}`}>{row.display_name}</Link>
                </td>
                <td className="p-2">
                  <StatusBadge status={row.status} />
                </td>
                <td className="p-2 font-mono text-xs">{row.slug}</td>
                <td className="p-2 text-neutral-500">
                  {new Date(row.created_at).toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const tone =
    status === 'running'
      ? 'bg-emerald-900/40 text-emerald-300'
      : status === 'failed'
        ? 'bg-red-900/40 text-red-300'
        : status === 'installing' || status === 'starting'
          ? 'bg-amber-900/40 text-amber-300'
          : 'bg-neutral-800 text-neutral-300';
  return <span className={`rounded px-2 py-0.5 text-xs ${tone}`}>{status}</span>;
}
