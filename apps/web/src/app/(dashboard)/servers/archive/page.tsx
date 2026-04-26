'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';

interface ArchiveRow {
  id: string;
  display_name: string;
  slug: string;
  deleted_at: string;
  deleted_by_steam_id64: string | null;
  deletion_backup_marker_id: string | null;
}

interface ArchiveResponse {
  items: ArchiveRow[];
  total: number;
}

interface Me {
  permissions: string[];
}

export default function ArchivePage() {
  const [data, setData] = useState<ArchiveResponse | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const m = await fetch('/api/v1/me', { credentials: 'include', cache: 'no-store' });
        if (m.ok) {
          const meBody = (await m.json()) as Me;
          if (!cancelled) setMe(meBody);
          if (!meBody.permissions.includes('server:view')) {
            if (!cancelled) setForbidden(true);
            return;
          }
        }
        const r = await fetch('/api/v1/servers/archive', {
          credentials: 'include',
          cache: 'no-store',
        });
        if (r.status === 403) {
          if (!cancelled) setForbidden(true);
          return;
        }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as ArchiveResponse;
        if (!cancelled) {
          setData(j);
          setErr(null);
        }
      } catch (e) {
        if (!cancelled) setErr((e as Error).message);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  if (forbidden) {
    return (
      <div className="rounded border border-red-900 bg-red-950 p-4 text-sm">
        Доступ запрещён. Требуется право <code className="font-mono">server:view</code>.
      </div>
    );
  }
  if (!data && !err) return <div className="text-neutral-500">Загрузка…</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Архив серверов</h1>
        <span className="text-xs text-neutral-500">{data ? `${data.total} запис(ей)` : ''}</span>
      </div>
      {err ? (
        <div className="rounded border border-red-900 bg-red-950 p-3 text-sm">{err}</div>
      ) : null}
      {data && data.items.length === 0 ? (
        <div className="rounded border border-neutral-800 bg-neutral-950 p-6 text-center text-neutral-500 text-sm">
          Нет удалённых серверов.
        </div>
      ) : data ? (
        <div className="overflow-x-auto rounded border border-neutral-800">
          <table className="w-full text-sm">
            <thead className="bg-neutral-950 text-xs uppercase tracking-widest text-neutral-500">
              <tr>
                <th className="text-left p-2">Имя</th>
                <th className="text-left p-2">Slug</th>
                <th className="text-left p-2">Удалён</th>
                <th className="text-left p-2">Кто удалил</th>
                <th className="text-left p-2">Бэкап</th>
                <th className="text-right p-2"></th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((row) => (
                <tr key={row.id} className="group border-t border-neutral-900 hover:bg-neutral-950">
                  <td className="p-2">
                    <Link
                      href={`/servers/archive/${row.id}`}
                      className="text-sky-400 hover:text-sky-300 font-medium"
                    >
                      {row.display_name}
                    </Link>
                    <div className="text-[11px] text-neutral-500 font-mono">{row.id}</div>
                  </td>
                  <td className="p-2 font-mono text-xs">{row.slug}</td>
                  <td
                    className="p-2 text-xs text-neutral-300"
                    title={new Date(row.deleted_at).toLocaleString()}
                  >
                    {formatRelative(row.deleted_at)}
                  </td>
                  <td className="p-2 font-mono text-xs">{row.deleted_by_steam_id64 ?? '—'}</td>
                  <td className="p-2 text-xs">{row.deletion_backup_marker_id ? 'есть' : '—'}</td>
                  <td className="p-2 text-right">
                    <Link
                      href={`/servers/archive/${row.id}/restore`}
                      className="invisible rounded bg-sky-700 px-2 py-1 text-xs text-white hover:bg-sky-600 group-hover:visible"
                    >
                      Восстановить
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {me ? null : null}
    </div>
  );
}

function formatRelative(iso: string): string {
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return iso;
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return `${diffSec}с назад`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}м назад`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}ч назад`;
  return `${Math.floor(diffSec / 86400)}д назад`;
}
