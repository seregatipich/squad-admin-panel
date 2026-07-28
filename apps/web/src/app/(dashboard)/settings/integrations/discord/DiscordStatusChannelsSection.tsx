'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * DISCORD-6 (#153): pick the Discord voice/text channel the worker renames to
 * the live server state. The panel stores only the channel id; the rename
 * itself happens in `@squad/worker-discord`.
 *
 * Self-hides on 403 rather than gating on a capability flag, because
 * `GET /api/v1/me` does not expose `integration:manage` as a boolean.
 */

interface StatusChannelRow {
  server_id: string;
  display_name: string;
  slug: string;
  channel_id: string | null;
}

/** Preview of the name the worker will write, or null when nothing is configured. */
export function statusChannelPreview(channelId: string | null): string | null {
  if (!channelId) return null;
  return '🟢карта_00x0_админов0';
}

export default function DiscordStatusChannelsSection() {
  const [rows, setRows] = useState<StatusChannelRow[] | null>(null);
  const [hidden, setHidden] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/v1/integrations/discord/status-channels', {
      credentials: 'include',
      cache: 'no-store',
    });
    if (res.status === 401 || res.status === 403) {
      setHidden(true);
      return;
    }
    if (!res.ok) {
      setError('Не удалось загрузить статус-каналы.');
      return;
    }
    const body = (await res.json()) as { items: StatusChannelRow[] };
    setRows(body.items);
    setDrafts(Object.fromEntries(body.items.map((i) => [i.server_id, i.channel_id ?? ''])));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(row: StatusChannelRow) {
    const raw = (drafts[row.server_id] ?? '').trim();
    setBusy(row.server_id);
    setError(null);
    setSaved(null);
    try {
      const res = await fetch(
        `/api/v1/integrations/discord/servers/${row.server_id}/status-channel`,
        {
          method: 'PUT',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ channel_id: raw === '' ? null : raw }),
        },
      );
      if (!res.ok) {
        setError(`Не удалось сохранить статус-канал для ${row.display_name}.`);
        return;
      }
      setSaved(row.server_id);
      await load();
    } catch {
      setError(`Не удалось сохранить статус-канал для ${row.display_name}.`);
    } finally {
      setBusy(null);
    }
  }

  if (hidden) return null;

  return (
    <section className="rounded border border-neutral-800 bg-neutral-950 p-4 space-y-2">
      <h2 className="text-xs uppercase tracking-widest text-neutral-400">Статус-каналы</h2>
      <p className="text-xs text-neutral-500">
        Воркер переименовывает указанный канал в живой статус сервера. Пустое поле — статус-канал
        отключён.
      </p>
      {error && (
        <div
          role="alert"
          className="rounded border border-red-900 bg-red-950 px-2 py-1 text-sm text-red-200"
        >
          {error}
        </div>
      )}
      {rows === null ? (
        <p className="text-sm text-neutral-500">Загрузка…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-neutral-500">Серверов пока нет.</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => {
            const preview = statusChannelPreview(drafts[row.server_id]?.trim() || null);
            return (
              <li key={row.server_id} className="flex flex-wrap items-center gap-2">
                <span className="min-w-[140px] text-sm text-neutral-200">{row.display_name}</span>
                <input
                  aria-label={`ID статус-канала для ${row.display_name}`}
                  value={drafts[row.server_id] ?? ''}
                  onChange={(e) => setDrafts((d) => ({ ...d, [row.server_id]: e.target.value }))}
                  placeholder="ID канала"
                  className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm text-neutral-200"
                />
                <button
                  type="button"
                  aria-label={`Сохранить статус-канал ${row.display_name}`}
                  disabled={busy === row.server_id}
                  onClick={() => void save(row)}
                  className="rounded border border-neutral-700 px-2 py-1 text-sm text-neutral-200 disabled:opacity-50"
                >
                  Сохранить
                </button>
                {preview && <span className="text-xs text-neutral-500">→ {preview}</span>}
                {saved === row.server_id && (
                  <span className="text-xs text-emerald-400">Сохранено</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
