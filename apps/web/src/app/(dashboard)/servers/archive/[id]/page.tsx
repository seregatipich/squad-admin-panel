'use client';
import Link from 'next/link';
import { use, useEffect, useState } from 'react';

interface ArchiveServer {
  id: string;
  display_name: string;
  slug: string;
  description: string | null;
  deleted_at: string;
  deleted_by_steam_id64: string | null;
  deletion_backup_marker_id: string | null;
  tags: string[] | null;
}

interface ArchiveSettings {
  install_path: string;
  game_port: number;
  query_port: number;
  beacon_port: number;
  rcon_port: number;
  max_players: number;
  tickrate: number;
  multihome: string | null;
}

interface BackupRow {
  id: string;
  filename: string;
  sha256_hex: string;
  message: string | null;
  created_at: string;
  author_steam_id64: string | null;
  author_label: string | null;
}

interface ArchiveDetail {
  server: ArchiveServer;
  settings: ArchiveSettings | null;
  backups: BackupRow[];
}

interface BackupContent {
  id: string;
  filename: string;
  content: string;
  sha256_hex: string;
  created_at: string;
  message: string | null;
}

export default function ArchiveDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [data, setData] = useState<ArchiveDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [openFile, setOpenFile] = useState<BackupContent | null>(null);
  const [loadingFile, setLoadingFile] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch(`/api/v1/servers/archive/${id}`, {
          credentials: 'include',
          cache: 'no-store',
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as ArchiveDetail;
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
  }, [id]);

  async function viewFile(filename: string) {
    setLoadingFile(filename);
    try {
      const r = await fetch(
        `/api/v1/servers/archive/${id}/configs/${encodeURIComponent(filename)}`,
        { credentials: 'include', cache: 'no-store' },
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = (await r.json()) as BackupContent;
      setOpenFile(body);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoadingFile(null);
    }
  }

  if (err && !data) {
    return (
      <div className="rounded border border-red-900 bg-red-950 p-3 text-sm">Ошибка: {err}</div>
    );
  }
  if (!data) return <div className="text-neutral-500">Загрузка…</div>;

  const { server, settings, backups } = data;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold">{server.display_name}</h1>
            <span className="rounded bg-neutral-800 px-2 py-0.5 text-xs uppercase tracking-widest text-neutral-300">
              archived
            </span>
          </div>
          <div className="text-xs text-neutral-500 font-mono">{server.id}</div>
          <div className="text-xs text-neutral-400">
            Удалён {new Date(server.deleted_at).toLocaleString()}
            {server.deleted_by_steam_id64 ? ` · ${server.deleted_by_steam_id64}` : ''}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/servers/archive"
            className="rounded border border-neutral-700 px-3 py-1.5 text-xs hover:bg-neutral-800"
          >
            ← К архиву
          </Link>
          <Link
            href={`/servers/archive/${server.id}/restore`}
            className="rounded bg-sky-600 px-3 py-1.5 text-sm text-white hover:bg-sky-500"
          >
            Восстановить сервер
          </Link>
        </div>
      </header>

      {err ? (
        <div className="rounded border border-red-900 bg-red-950 p-3 text-sm">{err}</div>
      ) : null}

      <section className="rounded border border-neutral-800 bg-neutral-950 p-4">
        <h2 className="text-xs uppercase tracking-widest text-neutral-400 mb-3">Параметры</h2>
        {settings ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 font-mono text-xs">
            <dt className="text-neutral-500">Slug</dt>
            <dd>{server.slug}</dd>
            <dt className="text-neutral-500">Game</dt>
            <dd>{settings.game_port}</dd>
            <dt className="text-neutral-500">Query</dt>
            <dd>{settings.query_port}</dd>
            <dt className="text-neutral-500">Beacon</dt>
            <dd>{settings.beacon_port}</dd>
            <dt className="text-neutral-500">RCON</dt>
            <dd>{settings.rcon_port}</dd>
            <dt className="text-neutral-500">Макс. игроков</dt>
            <dd>{settings.max_players}</dd>
            <dt className="text-neutral-500">Tickrate</dt>
            <dd>{settings.tickrate}</dd>
          </dl>
        ) : (
          <div className="text-neutral-500 text-xs">нет настроек</div>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-xs uppercase tracking-widest text-neutral-400">Бэкап конфигов</h2>
        {backups.length === 0 ? (
          <div className="rounded border border-neutral-800 bg-neutral-950 p-4 text-sm text-neutral-500">
            Бэкап пуст — конфиги не сохранились перед удалением.
          </div>
        ) : (
          <div className="overflow-x-auto rounded border border-neutral-800">
            <table className="w-full text-sm">
              <thead className="bg-neutral-950 text-xs uppercase tracking-widest text-neutral-500">
                <tr>
                  <th className="text-left p-2">Файл</th>
                  <th className="text-left p-2">SHA-256</th>
                  <th className="text-left p-2">Сообщение</th>
                  <th className="text-left p-2">Сохранён</th>
                </tr>
              </thead>
              <tbody>
                {backups.map((b) => (
                  <tr key={b.id} className="border-t border-neutral-900">
                    <td className="p-2">
                      <button
                        type="button"
                        onClick={() => viewFile(b.filename)}
                        className="text-sky-400 hover:text-sky-300 font-mono text-xs"
                        disabled={loadingFile === b.filename}
                      >
                        {loadingFile === b.filename ? '…' : b.filename}
                      </button>
                    </td>
                    <td className="p-2 font-mono text-[11px] text-neutral-400">
                      {b.sha256_hex.slice(0, 12)}
                    </td>
                    <td className="p-2 text-xs text-neutral-400">{b.message ?? '—'}</td>
                    <td className="p-2 text-xs text-neutral-500">
                      {new Date(b.created_at).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {openFile ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={openFile.filename}
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
        >
          <button
            type="button"
            aria-label="Закрыть"
            onClick={() => setOpenFile(null)}
            className="absolute inset-0 bg-black/70"
          />
          <div className="relative flex max-h-[80vh] w-full max-w-4xl flex-col rounded border border-neutral-700 bg-neutral-950">
            <header className="flex items-center justify-between border-b border-neutral-800 p-3">
              <div className="flex items-baseline gap-3">
                <h3 className="font-mono text-sm">{openFile.filename}</h3>
                <span className="font-mono text-[11px] text-neutral-500">
                  sha256: {openFile.sha256_hex.slice(0, 12)}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setOpenFile(null)}
                className="rounded border border-neutral-700 px-2 py-0.5 text-xs hover:bg-neutral-800"
              >
                Закрыть
              </button>
            </header>
            <pre className="flex-1 overflow-auto p-4 font-mono text-xs whitespace-pre-wrap break-all">
              {openFile.content}
            </pre>
          </div>
        </div>
      ) : null}
    </div>
  );
}
