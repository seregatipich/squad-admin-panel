import type { RoleColor } from '@squad/shared-config/role-colors';
import { cookies } from 'next/headers';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { RoleColorDot } from '@/components/RoleColorDot';
import { apiFetch } from '@/lib/api';
import { requireSession, SESSION_COOKIE } from '@/lib/dal';
import { formatVipExpiry } from '@/lib/role-expiry';

export const dynamic = 'force-dynamic';

interface RoleOption {
  id: string;
  name: string;
  color: RoleColor;
}

interface RoleAssignmentRow {
  id: string;
  steam_id64: string | null;
  eos_id: string | null;
  canonical_name: string;
  role: { id: string; name: string; color: RoleColor };
  role_expires_at: string | null;
  role_comment: string | null;
  last_seen_at: string;
}

interface VipsPageProps {
  searchParams: Promise<{ role_id?: string; expiring_soon?: string }>;
}

/**
 * `/vips` — read-only registry of every player currently holding a panel
 * role (VIPSUB-2, issue #168): role badge, SteamID64/EOS identity, expiry
 * (permanent vs. a relative countdown), and the assignment comment.
 *
 * Server-rendered through `lib/dal.ts`/`lib/api.ts` against
 * `GET /api/v1/role-assignments`; the role and "expiring soon" filters are
 * plain query-string search params so the page works without client JS.
 */
export default async function VipsPage({ searchParams }: VipsPageProps) {
  const me = await requireSession();
  if (!me.permissions.includes('user:view')) {
    redirect('/dashboard');
  }

  const params = await searchParams;
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  const cookie = token ? `${SESSION_COOKIE}=${token}` : '';

  const query = new URLSearchParams();
  if (params.role_id) query.set('role_id', params.role_id);
  const expiringSoon = params.expiring_soon === 'true';
  if (expiringSoon) query.set('expiring_soon', 'true');
  const qs = query.toString();

  let rows: RoleAssignmentRow[] = [];
  try {
    rows = await apiFetch<RoleAssignmentRow[]>(`/api/v1/role-assignments${qs ? `?${qs}` : ''}`, {
      cookie,
    });
  } catch {
    rows = [];
  }

  let roleOptions: RoleOption[] = [];
  try {
    roleOptions = await apiFetch<RoleOption[]>('/api/v1/roles', { cookie });
  } catch {
    roleOptions = [];
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">VIP-роли</h1>
        <span className="text-xs text-neutral-500">{rows.length} игрок(ов)</span>
      </div>

      <form method="GET" className="flex flex-wrap items-center gap-3 text-sm">
        <select
          name="role_id"
          defaultValue={params.role_id ?? ''}
          className="rounded border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-sm"
        >
          <option value="">Все роли</option>
          {roleOptions.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-neutral-300">
          <input type="checkbox" name="expiring_soon" value="true" defaultChecked={expiringSoon} />
          Истекают скоро
        </label>
        <button
          type="submit"
          className="rounded bg-sky-600 px-3 py-1.5 text-sm text-white hover:bg-sky-500"
        >
          Применить
        </button>
        {params.role_id || expiringSoon ? (
          <Link href="/vips" className="text-xs text-neutral-400 underline hover:text-neutral-200">
            Сбросить
          </Link>
        ) : null}
      </form>

      <div className="overflow-hidden rounded border border-neutral-800">
        <table className="w-full text-sm">
          <thead className="bg-neutral-900 text-xs uppercase tracking-widest text-neutral-400">
            <tr>
              <th className="p-2 text-left">Роль</th>
              <th className="p-2 text-left">Игрок</th>
              <th className="p-2 text-left">SteamID64 / EOS</th>
              <th className="p-2 text-left">Срок</th>
              <th className="p-2 text-left">Комментарий</th>
              <th className="p-2 text-left">Last seen</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="p-3 text-neutral-500">
                  Нет игроков по фильтру
                </td>
              </tr>
            ) : null}
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-neutral-900">
                <td className="p-2">
                  <span className="inline-flex items-center gap-2">
                    <RoleColorDot color={r.role.color} />
                    {r.role.name}
                  </span>
                </td>
                <td className="p-2">
                  <Link href={`/players/${r.id}`} className="text-sky-400 hover:text-sky-300">
                    {r.canonical_name}
                  </Link>
                </td>
                <td className="p-2 font-mono text-xs">{r.steam_id64 ?? r.eos_id ?? '—'}</td>
                <td className="p-2 text-neutral-300">{formatVipExpiry(r.role_expires_at)}</td>
                <td className="p-2 text-neutral-500">
                  {r.role_comment ? (
                    <span className="block max-w-56 truncate" title={r.role_comment}>
                      {r.role_comment}
                    </span>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="p-2 text-neutral-500">
                  {new Date(r.last_seen_at).toLocaleString('ru-RU')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
