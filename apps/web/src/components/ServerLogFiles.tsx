'use client';

import { useEffect, useState } from 'react';

interface LogFile {
  name: string;
  size: number;
  mtime: string;
  is_live: boolean;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || Number.isInteger(value) ? 0 : 1)} ${units[unit]}`;
}

function formatMtime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

/**
 * Lists the on-disk `SquadGame*.log` files for a server (name, size, mtime,
 * a "live" badge on the active `SquadGame.log`) and offers a streaming download
 * of each one. Renders nothing when the current user lacks
 * `server:download_logs` — callers pass that as `canDownload` (from
 * `GET /api/v1/me`'s `permissions`).
 */
export function ServerLogFiles({
  serverId,
  canDownload,
}: {
  serverId: string;
  canDownload: boolean;
}) {
  const [files, setFiles] = useState<LogFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!canDownload) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const r = await fetch(`/api/v1/servers/${serverId}/logs/files`, {
          credentials: 'include',
          cache: 'no-store',
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const body = (await r.json()) as { files: LogFile[] };
        if (!cancelled) {
          setFiles(body.files);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [serverId, canDownload]);

  if (!canDownload) return null;

  return (
    <section className="rounded border border-neutral-800 bg-neutral-950 p-4">
      <h2 className="mb-3 text-sm font-semibold text-neutral-200">Логи</h2>
      {error ? (
        <p className="text-sm text-red-400">Не удалось загрузить список файлов: {error}</p>
      ) : loading ? (
        <p className="text-sm text-neutral-500">Загрузка…</p>
      ) : files.length === 0 ? (
        <p className="text-sm text-neutral-500">нет файлов</p>
      ) : (
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="text-neutral-500">
              <th className="py-1 pr-2 font-medium">Файл</th>
              <th className="py-1 pr-2 font-medium">Размер</th>
              <th className="py-1 pr-2 font-medium">Изменён</th>
              <th className="py-1 font-medium" />
            </tr>
          </thead>
          <tbody className="font-mono">
            {files.map((f) => (
              <tr key={f.name} className="border-t border-neutral-900">
                <td className="py-1 pr-2">
                  <span className="text-neutral-200">{f.name}</span>
                  {f.is_live ? (
                    <span className="ml-2 rounded bg-emerald-900 px-1 text-[10px] font-semibold text-emerald-200 uppercase">
                      live
                    </span>
                  ) : null}
                </td>
                <td className="py-1 pr-2 text-neutral-400">{formatSize(f.size)}</td>
                <td className="py-1 pr-2 text-neutral-400">{formatMtime(f.mtime)}</td>
                <td className="py-1 text-right">
                  <a
                    href={`/api/v1/servers/${serverId}/logs/files/${encodeURIComponent(f.name)}/download`}
                    download
                    className="rounded bg-neutral-800 px-2 py-0.5 text-neutral-200 hover:bg-neutral-700"
                  >
                    ⤓ Скачать
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
