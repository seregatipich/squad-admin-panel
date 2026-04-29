'use client';

import type { RoleColor } from '@squad/shared-config/role-colors';
import Link from 'next/link';
import { use, useCallback, useEffect, useState } from 'react';
import { RoleColorDot } from '@/components/RoleColorDot';

interface Member {
  steam_id64: string;
  canonical_name: string;
  last_seen_at: string;
}

interface MembersResponse {
  role: { id: string; name: string; color: string };
  items: Member[];
  total: number;
  limit: number;
  offset: number;
}

interface PlayerSearchItem {
  steam_id64: string;
  canonical_name: string;
  last_seen_at: string;
}

interface Me {
  permissions: string[];
}

const PAGE_SIZE = 100;

export default function RoleMembersPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [data, setData] = useState<MembersResponse | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [q, setQ] = useState('');
  const [offset, setOffset] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const load = useCallback(async () => {
    const url = new URL(`/api/v1/roles/${id}/members`, window.location.origin);
    url.searchParams.set('limit', String(PAGE_SIZE));
    url.searchParams.set('offset', String(offset));
    if (q.trim()) url.searchParams.set('q', q.trim());
    const r = await fetch(url.toString().replace(window.location.origin, ''), {
      credentials: 'include',
      cache: 'no-store',
    });
    if (!r.ok) {
      setErr(`HTTP ${r.status}`);
      return;
    }
    setData((await r.json()) as MembersResponse);
  }, [id, offset, q]);

  useEffect(() => {
    void load();
    fetch('/api/v1/me', { credentials: 'include', cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => setMe(j as Me | null))
      .catch(() => {});
  }, [load]);

  const canManage = me?.permissions.includes('user:manage_roles') ?? false;

  async function removeMember(steamId64: string, name: string) {
    if (!canManage) return;
    if (!confirm(`Снять роль с игрока «${name}»?`)) return;
    setErr(null);
    const r = await fetch(`/api/v1/roles/${id}/members/${steamId64}`, {
      method: 'DELETE',
      credentials: 'include',
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}) as Record<string, unknown>);
      setErr(`Ошибка: ${e.error ?? r.status}`);
      return;
    }
    await load();
  }

  async function addMember(steamId64: string) {
    setErr(null);
    const r = await fetch(`/api/v1/roles/${id}/members`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ steam_id64: steamId64 }),
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}) as Record<string, unknown>);
      setErr(`Ошибка: ${e.error ?? r.status}`);
      return;
    }
    setAddOpen(false);
    await load();
  }

  if (err) {
    return (
      <div className="space-y-3">
        <Link href="/settings/groups" className="text-sky-400 text-xs">
          ← Назад к списку ролей
        </Link>
        <div className="rounded border border-red-900 bg-red-950 p-3 text-sm text-red-200">
          {err}
        </div>
      </div>
    );
  }
  if (!data) return <div className="text-neutral-500">Загрузка…</div>;

  const totalPages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/settings/groups" className="text-sky-400 text-xs">
            ← Назад к списку ролей
          </Link>
          <RoleColorDot color={data.role.color as RoleColor | string} />
          <h1 className="text-2xl font-semibold">{data.role.name}</h1>
          <span className="text-sm text-neutral-500">— {data.total} участников</span>
        </div>
        {canManage ? (
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            className="rounded-md border border-sky-700 bg-sky-950 px-3 py-1.5 text-sm text-sky-200 hover:bg-sky-900"
          >
            + Добавить игрока
          </button>
        ) : null}
      </div>

      <div className="flex items-center gap-2">
        <input
          type="text"
          placeholder="Поиск по нику или SteamID64…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOffset(0);
          }}
          className="w-80 rounded border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-sm"
        />
      </div>

      <table className="w-full table-fixed border-collapse text-sm">
        <thead className="text-left text-xs uppercase tracking-widest text-neutral-500">
          <tr>
            <th className="border-b border-neutral-800 px-2 py-2">Никнейм</th>
            <th className="w-44 border-b border-neutral-800 px-2 py-2">SteamID64</th>
            <th className="w-44 border-b border-neutral-800 px-2 py-2">Last seen</th>
            <th className="w-28 border-b border-neutral-800 px-2 py-2 text-right">Действие</th>
          </tr>
        </thead>
        <tbody>
          {data.items.length === 0 ? (
            <tr>
              <td colSpan={4} className="px-2 py-3 text-neutral-500">
                Нет участников
              </td>
            </tr>
          ) : null}
          {data.items.map((m) => (
            <tr key={m.steam_id64} className="border-b border-neutral-900 hover:bg-neutral-900/40">
              <td className="px-2 py-2">
                <Link href={`/players/${m.steam_id64}`} className="text-sky-400 hover:text-sky-300">
                  {m.canonical_name}
                </Link>
              </td>
              <td className="px-2 py-2 font-mono text-xs">{m.steam_id64}</td>
              <td className="px-2 py-2 text-xs text-neutral-400">
                {new Date(m.last_seen_at).toLocaleString('ru-RU')}
              </td>
              <td className="px-2 py-2 text-right">
                {canManage ? (
                  <button
                    type="button"
                    onClick={() => removeMember(m.steam_id64, m.canonical_name)}
                    className="rounded border border-red-900 px-2 py-0.5 text-xs text-red-300 hover:bg-red-950"
                  >
                    Снять
                  </button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="flex items-center justify-between">
        <div className="text-xs text-neutral-500">
          Страница {currentPage} / {totalPages}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            className="rounded border border-neutral-800 px-2 py-0.5 text-xs disabled:opacity-40"
          >
            ← пред.
          </button>
          <button
            type="button"
            disabled={offset + PAGE_SIZE >= data.total}
            onClick={() => setOffset(offset + PAGE_SIZE)}
            className="rounded border border-neutral-800 px-2 py-0.5 text-xs disabled:opacity-40"
          >
            след. →
          </button>
        </div>
      </div>

      {addOpen ? (
        <AddMemberModal onClose={() => setAddOpen(false)} onAdd={(p) => addMember(p.steam_id64)} />
      ) : null}
    </div>
  );
}

function AddMemberModal({
  onClose,
  onAdd,
}: {
  onClose: () => void;
  onAdd: (p: PlayerSearchItem) => void;
}) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<PlayerSearchItem[]>([]);

  useEffect(() => {
    const handler = setTimeout(async () => {
      if (q.trim().length < 2) {
        setResults([]);
        return;
      }
      const url = new URL('/api/v1/players', window.location.origin);
      url.searchParams.set('q', q.trim());
      const r = await fetch(url.toString().replace(window.location.origin, ''), {
        credentials: 'include',
        cache: 'no-store',
      });
      if (r.ok) {
        const j = (await r.json()) as { items: PlayerSearchItem[] };
        setResults(j.items.slice(0, 30));
      }
    }, 250);
    return () => clearTimeout(handler);
  }, [q]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
      <div className="w-full max-w-lg rounded-lg border border-neutral-800 bg-neutral-950 p-5">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-lg font-semibold">Добавить игрока</h3>
          <button
            type="button"
            onClick={onClose}
            className="text-xs text-neutral-400 hover:text-neutral-200"
          >
            закрыть
          </button>
        </div>
        <input
          type="text"
          placeholder="Ник или SteamID64…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-sm"
        />
        <ul className="mt-3 max-h-80 divide-y divide-neutral-900 overflow-auto">
          {results.length === 0 ? (
            <li className="py-2 text-xs text-neutral-500">Введите хотя бы 2 символа для поиска…</li>
          ) : null}
          {results.map((r) => (
            <li key={r.steam_id64} className="flex items-center justify-between py-2">
              <div className="flex flex-col">
                <span className="text-sm">{r.canonical_name}</span>
                <span className="font-mono text-[11px] text-neutral-500">{r.steam_id64}</span>
              </div>
              <button
                type="button"
                onClick={() => onAdd(r)}
                className="rounded border border-sky-700 bg-sky-950 px-2 py-0.5 text-xs text-sky-200 hover:bg-sky-900"
              >
                Назначить
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
