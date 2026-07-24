'use client';
import { useCallback, useEffect, useState } from 'react';
import { BackupTriggerButton } from '@/components/BackupTriggerButton';
import { LiveIndicator } from '@/components/LiveIndicator';
import { RestoreSnapshotButton } from '@/components/RestoreSnapshotButton';

const POLL_MS = 30_000;

interface Snapshot {
  id: string;
  short_id: string;
  time: string;
  hostname: string;
  paths: string[];
  tags: string[];
}

type Load =
  | { kind: 'loading' }
  | { kind: 'forbidden' }
  | { kind: 'error'; text: string }
  | { kind: 'ready'; snapshots: Snapshot[] };

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('ru-RU');
}

export default function BackupPage() {
  const [state, setState] = useState<Load>({ kind: 'loading' });
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/v1/host/backups', {
        credentials: 'include',
        cache: 'no-store',
      });
      if (res.status === 403) {
        setState({ kind: 'forbidden' });
        return;
      }
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { detail?: string };
        setState({ kind: 'error', text: j.detail ?? `HTTP ${res.status}` });
        return;
      }
      const body = (await res.json()) as { snapshots: Snapshot[] };
      setState({ kind: 'ready', snapshots: body.snapshots });
      setLastUpdate(new Date());
    } catch (e) {
      setState({ kind: 'error', text: (e as Error).message });
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Бэкапы</h1>
        <div className="flex items-center gap-3">
          <BackupTriggerButton
            disabled={state.kind === 'forbidden'}
            disabledReason="Нет прав на управление хостом"
            onBackedUp={() => void load()}
          />
          <LiveIndicator lastUpdate={lastUpdate} />
        </div>
      </div>

      <p className="text-sm text-neutral-400">
        Резервные копии Postgres и Redis снимаются восстановимыми логическими дампами (pg_dump +
        RDB) и хранятся в зашифрованном restic-репозитории. Ежедневный снимок делается по
        расписанию; здесь можно снять внеочередной бэкап или восстановить панель из выбранного
        снимка.
      </p>

      {state.kind === 'forbidden' ? (
        <div className="rounded border border-amber-900 bg-amber-950/40 p-4 text-sm text-amber-200">
          Недостаточно прав. Для просмотра и управления бэкапами нужно разрешение управления
          хост-демоном (host:manage).
        </div>
      ) : null}

      {state.kind === 'error' ? (
        <div className="rounded border border-red-900 bg-red-950 p-4 text-sm text-red-200">
          Не удалось загрузить список бэкапов: {state.text}
        </div>
      ) : null}

      {state.kind === 'loading' ? <div className="text-sm text-neutral-500">Загрузка…</div> : null}

      {state.kind === 'ready' ? (
        <section className="space-y-3 rounded border border-neutral-800 bg-neutral-950 p-4">
          <h2 className="text-xs uppercase tracking-widest text-neutral-400">Снимки</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase text-neutral-500">
                <tr>
                  <th className="py-2 pr-2">ID</th>
                  <th className="py-2 pr-2">Дата</th>
                  <th className="py-2 pr-2">Хост</th>
                  <th className="py-2 pr-2">Теги</th>
                  <th className="py-2 pr-2" />
                </tr>
              </thead>
              <tbody>
                {state.snapshots.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-3 text-center text-xs text-neutral-500">
                      Снимков пока нет. Нажмите «Создать бэкап», чтобы сделать первый.
                    </td>
                  </tr>
                ) : (
                  state.snapshots.map((s) => (
                    <tr key={s.id} className="border-t border-neutral-900 align-top">
                      <td className="py-2 pr-2 font-mono text-xs text-neutral-300">{s.short_id}</td>
                      <td className="py-2 pr-2 text-neutral-400">{formatDate(s.time)}</td>
                      <td className="py-2 pr-2 text-neutral-400">{s.hostname}</td>
                      <td className="py-2 pr-2">
                        {s.tags.length === 0 ? (
                          <span className="text-xs text-neutral-500">—</span>
                        ) : (
                          <div className="flex flex-wrap gap-1">
                            {s.tags.map((t) => (
                              <span
                                key={t}
                                className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-[10px] text-neutral-300"
                              >
                                {t}
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="py-2 pr-2 text-right">
                        <RestoreSnapshotButton
                          shortId={s.short_id}
                          time={formatDate(s.time)}
                          onRestored={() => void load()}
                        />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}
