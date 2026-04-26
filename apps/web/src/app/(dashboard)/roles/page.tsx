'use client';
import type { RoleColor } from '@squad/shared-config/role-colors';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { RoleColorDot } from '@/components/RoleColorDot';

interface RoleRow {
  id: string;
  name: string;
  color: RoleColor;
  description: string | null;
  is_system_role: boolean;
  permissions: string[];
  assigned_users_count: number;
}

interface Me {
  permissions: string[];
}

export default function RolesPage() {
  const [rows, setRows] = useState<RoleRow[] | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [rRes, mRes] = await Promise.all([
      fetch('/api/v1/roles', { credentials: 'include', cache: 'no-store' }),
      fetch('/api/v1/me', { credentials: 'include', cache: 'no-store' }),
    ]);
    if (rRes.ok) setRows((await rRes.json()) as RoleRow[]);
    if (mRes.ok) setMe((await mRes.json()) as Me);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function remove(role: RoleRow) {
    if (
      !confirm(
        `Удалить роль «${role.name}»? Это снимет роль у ${role.assigned_users_count} пользователей.`,
      )
    )
      return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/v1/roles/${role.id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!rows || !me) return <div className="text-neutral-500">Загрузка…</div>;
  const canCreate = me.permissions.includes('role:create');
  const canEdit = me.permissions.includes('role:edit');
  const canDelete = me.permissions.includes('role:delete');

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Роли</h1>
        {canCreate ? (
          <Link
            href="/roles/new"
            className="rounded bg-sky-600 px-4 py-2 text-sm text-white hover:bg-sky-500"
          >
            Создать роль
          </Link>
        ) : null}
      </div>
      {err ? (
        <div className="rounded border border-red-900 bg-red-950 p-3 text-sm text-red-200">
          {err}
        </div>
      ) : null}
      <div className="overflow-hidden rounded border border-neutral-800">
        <table className="w-full text-sm">
          <thead className="bg-neutral-900 text-xs uppercase tracking-widest text-neutral-400">
            <tr>
              <th className="p-2 text-left">Роль</th>
              <th className="p-2 text-left">Описание</th>
              <th className="p-2 text-left">Пользователей</th>
              <th className="p-2 text-right">Действия</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-neutral-900">
                <td className="p-2">
                  <div className="flex items-center gap-2">
                    <RoleColorDot color={r.color} />
                    <span className="font-medium">{r.name}</span>
                    {r.is_system_role ? (
                      <span className="rounded bg-amber-950/60 px-1.5 py-0.5 text-xs text-amber-300">
                        Системная
                      </span>
                    ) : null}
                  </div>
                </td>
                <td className="p-2 text-neutral-400">{r.description ?? '—'}</td>
                <td className="p-2 font-mono">{r.assigned_users_count}</td>
                <td className="p-2 text-right">
                  {canEdit ? (
                    <Link
                      href={`/roles/${r.id}`}
                      className="rounded border border-neutral-800 px-3 py-0.5 text-xs hover:border-neutral-600"
                    >
                      {r.is_system_role && r.name === 'Owner' ? 'Просмотр' : 'Редактировать'}
                    </Link>
                  ) : null}
                  {canDelete && !(r.is_system_role && r.name === 'Owner') ? (
                    <button
                      type="button"
                      onClick={() => remove(r)}
                      disabled={busy}
                      className="ml-2 rounded border border-red-900 px-3 py-0.5 text-xs text-red-400 hover:border-red-700 disabled:opacity-40"
                    >
                      Удалить
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
