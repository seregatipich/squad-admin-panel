import { cookies } from 'next/headers';
import { apiFetch } from '@/lib/api';
import { SESSION_COOKIE } from '@/lib/dal';

interface AuditEntry {
  id: string;
  created_at: string;
  actor_user_id: string | null;
  action_type: string;
  target_type: string | null;
  target_id: string | null;
  status_code: number | null;
  duration_ms: number | null;
}

export default async function AuditPage() {
  const jar = await cookies();
  const cookie = `${SESSION_COOKIE}=${jar.get(SESSION_COOKIE)?.value ?? ''}`;
  const data = await apiFetch<{ items: AuditEntry[] }>('/api/v1/audit?page=1&page_size=50', {
    cookie,
  });

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Журнал действий</h1>
      <table className="w-full text-sm">
        <thead className="text-xs uppercase tracking-widest text-neutral-500">
          <tr>
            <th className="text-left p-2">Время</th>
            <th className="text-left p-2">Actor</th>
            <th className="text-left p-2">Действие</th>
            <th className="text-left p-2">Цель</th>
            <th className="text-right p-2">Код</th>
            <th className="text-right p-2">ms</th>
          </tr>
        </thead>
        <tbody>
          {data.items.map((r) => (
            <tr key={r.id} className="border-t border-neutral-900">
              <td className="p-2 text-neutral-500">{new Date(r.created_at).toLocaleString()}</td>
              <td className="p-2 font-mono text-xs">{r.actor_user_id ?? 'system'}</td>
              <td className="p-2 font-mono text-xs">{r.action_type}</td>
              <td className="p-2 font-mono text-xs">
                {r.target_type ? `${r.target_type}:${r.target_id ?? '—'}` : '—'}
              </td>
              <td className="p-2 text-right">{r.status_code ?? '—'}</td>
              <td className="p-2 text-right">{r.duration_ms ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
