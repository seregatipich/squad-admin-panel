'use client';
import type { RoleColor } from '@squad/shared-config/role-colors';
import Link from 'next/link';
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { RoleColorDot } from '@/components/RoleColorDot';

interface UserRow {
  steam_id64: string;
  canonical_name: string;
  last_seen_at: string;
  role: { id: string; name: string; color: RoleColor; is_system_role: boolean };
}
interface RoleOption {
  id: string;
  name: string;
  color: RoleColor;
  is_system_role: boolean;
}
interface Me {
  permissions: string[];
}
interface PlayerHit {
  steam_id64: string;
  canonical_name: string;
}

export default function UsersPage() {
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [showAssign, setShowAssign] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch('/api/v1/users', { credentials: 'include', cache: 'no-store' });
    if (r.ok) setUsers((await r.json()) as UserRow[]);
    const m = await fetch('/api/v1/me', { credentials: 'include', cache: 'no-store' });
    if (m.ok) setMe((await m.json()) as Me);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (!users || !me) return <div className="text-neutral-500">Загрузка…</div>;
  const canManage = me.permissions.includes('user:manage_roles');

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Пользователи панели</h1>
        {canManage ? (
          <button
            type="button"
            onClick={() => setShowAssign(true)}
            className="rounded bg-sky-600 px-4 py-2 text-sm text-white hover:bg-sky-500"
          >
            Назначить роль игроку
          </button>
        ) : null}
      </div>
      <div className="overflow-hidden rounded border border-neutral-800">
        <table className="w-full text-sm">
          <thead className="bg-neutral-900 text-xs uppercase tracking-widest text-neutral-400">
            <tr>
              <th className="p-2 text-left">Игрок</th>
              <th className="p-2 text-left">SteamID64</th>
              <th className="p-2 text-left">Роль</th>
              <th className="p-2 text-left">Last seen</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.steam_id64} className="border-t border-neutral-900">
                <td className="p-2">
                  <Link
                    href={`/players/${u.steam_id64}`}
                    className="text-sky-400 hover:text-sky-300"
                  >
                    {u.canonical_name}
                  </Link>
                </td>
                <td className="p-2 font-mono text-xs">{u.steam_id64}</td>
                <td className="p-2">
                  <span className="inline-flex items-center gap-2">
                    <RoleColorDot color={u.role.color} />
                    {u.role.name}
                  </span>
                </td>
                <td className="p-2 text-neutral-500">
                  {new Date(u.last_seen_at).toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {showAssign ? (
        <AssignModal
          onClose={() => {
            setShowAssign(false);
            void load();
          }}
        />
      ) : null}
    </div>
  );
}

function AssignModal({ onClose }: { onClose: () => void }) {
  const uid = useId();
  const playerInputId = `${uid}-player`;
  const roleSelectId = `${uid}-role`;
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<PlayerHit[]>([]);
  const [picked, setPicked] = useState<PlayerHit | null>(null);
  const [roles, setRoles] = useState<RoleOption[] | null>(null);
  const [roleId, setRoleId] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/v1/roles', { credentials: 'include' })
      .then((r) => r.json())
      .then(setRoles);
  }, []);

  useEffect(() => {
    if (!q.trim()) {
      setHits([]);
      return;
    }
    const t = setTimeout(async () => {
      const r = await fetch(`/api/v1/players?q=${encodeURIComponent(q)}`, {
        credentials: 'include',
      });
      if (r.ok) {
        const body = (await r.json()) as { items: PlayerHit[] };
        setHits(body.items.slice(0, 20));
      }
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  const ownerRoleId = useMemo(
    () => roles?.find((r) => r.is_system_role && r.name === 'Owner')?.id ?? null,
    [roles],
  );

  async function assign() {
    if (!picked || !roleId) return;
    if (roleId === ownerRoleId) {
      if (!confirm('Это даст пользователю полный доступ к панели. Подтвердить?')) return;
    }
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/v1/players/${picked.steam_id64}/role`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role_id: roleId }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md space-y-4 rounded border border-neutral-800 bg-neutral-950 p-4">
        <h2 className="text-lg font-semibold">Назначить роль</h2>
        {err ? (
          <div className="rounded border border-red-900 bg-red-950 p-2 text-xs text-red-200">
            {err}
          </div>
        ) : null}
        <div>
          <label htmlFor={playerInputId} className="text-xs uppercase text-neutral-400">
            Игрок
          </label>
          <input
            id={playerInputId}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPicked(null);
            }}
            placeholder="ник или SteamID64"
            className="mt-1 w-full rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-sm"
          />
          {hits.length > 0 && !picked ? (
            <ul className="mt-1 max-h-40 overflow-auto rounded border border-neutral-800">
              {hits.map((h) => (
                <li key={h.steam_id64}>
                  <button
                    type="button"
                    onClick={() => {
                      setPicked(h);
                      setHits([]);
                      setQ(h.canonical_name);
                    }}
                    className="block w-full px-2 py-1 text-left text-sm hover:bg-neutral-900"
                  >
                    {h.canonical_name}{' '}
                    <span className="font-mono text-xs text-neutral-500">{h.steam_id64}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <div>
          <label htmlFor={roleSelectId} className="text-xs uppercase text-neutral-400">
            Роль
          </label>
          <select
            id={roleSelectId}
            value={roleId}
            onChange={(e) => setRoleId(e.target.value)}
            className="mt-1 w-full rounded border border-neutral-800 bg-neutral-950 px-2 py-2 text-sm"
          >
            <option value="">— выберите —</option>
            {(roles ?? []).map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-neutral-800 px-3 py-1 text-sm hover:border-neutral-600"
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={assign}
            disabled={busy || !picked || !roleId}
            className="rounded bg-sky-600 px-3 py-1 text-sm text-white hover:bg-sky-500 disabled:opacity-40"
          >
            Назначить
          </button>
        </div>
      </div>
    </div>
  );
}
