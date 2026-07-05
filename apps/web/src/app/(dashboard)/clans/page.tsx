'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';

interface Clan {
  id: string;
  name: string;
  tags: string[];
  description: string | null;
  member_count: number;
  priority_count: number;
  max_priority_slots: number;
}

interface ClansResponse {
  items: Clan[];
  total: number;
}

export default function ClansPage() {
  const [data, setData] = useState<ClansResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/v1/clans', { credentials: 'include', cache: 'no-store' });
      if (!res.ok) throw new Error(`Не удалось загрузить кланы (${res.status})`);
      setData((await res.json()) as ClansResponse);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo(() => {
    if (!data) return [];
    const needle = q.trim().toLowerCase();
    if (!needle) return data.items;
    return data.items.filter(
      (clan) =>
        clan.name.toLowerCase().includes(needle) ||
        clan.tags.some((tag) => tag.toLowerCase().includes(needle)),
    );
  }, [data, q]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Кланы</h1>
        <div className="text-xs text-neutral-500">всего: {data?.total ?? 0}</div>
      </div>

      {err ? (
        <div className="rounded border border-red-900 bg-red-950 p-3 text-sm">{err}</div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Поиск по имени или тегу…"
          className="flex-1 min-w-[260px] rounded border border-neutral-800 bg-neutral-950 px-3 py-1.5 text-sm"
        />
      </div>

      {rows.length === 0 ? (
        <div className="rounded border border-neutral-800 bg-neutral-950 p-6 text-center text-neutral-500 text-sm">
          {data?.items.length ? 'Нет совпадений.' : 'Кланы ещё не созданы.'}
        </div>
      ) : (
        <div className="overflow-x-auto rounded border border-neutral-800">
          <table className="w-full text-sm">
            <thead className="bg-neutral-950 text-xs uppercase tracking-widest text-neutral-500">
              <tr>
                <th className="text-left p-2">Название</th>
                <th className="text-left p-2">Теги</th>
                <th className="text-left p-2">Участников</th>
                <th className="text-left p-2">Приоритет</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((clan) => (
                <tr key={clan.id} className="border-t border-neutral-900 hover:bg-neutral-900/40">
                  <td className="p-2">
                    <Link href={`/clans/${clan.id}`} className="text-sky-400 hover:text-sky-300">
                      {clan.name}
                    </Link>
                  </td>
                  <td className="p-2">
                    <div className="flex flex-wrap gap-1">
                      {clan.tags.map((tag) => (
                        <span
                          key={tag}
                          className="rounded bg-neutral-800 px-1.5 py-0.5 text-xs text-neutral-300"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="p-2">{clan.member_count}</td>
                  <td className="p-2 text-neutral-400">
                    {clan.priority_count} / {clan.max_priority_slots}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
