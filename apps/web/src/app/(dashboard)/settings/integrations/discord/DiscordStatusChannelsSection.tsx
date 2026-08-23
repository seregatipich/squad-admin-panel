'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  InlineBanner,
  Skeleton,
  TextInput,
} from '@/components/ui';

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
    <Card padding="none" as="section">
      <CardHeader
        title="Статус-каналы"
        description="Воркер переименовывает указанный канал в живой статус сервера. Пустое поле — статус-канал отключён."
      />

      {error && (
        <CardBody padding="sm">
          <InlineBanner tone="crit" title={error} />
        </CardBody>
      )}

      {rows === null ? (
        <CardBody padding="sm">
          <Skeleton variant="row" count={2} label="Загрузка статус-каналов" />
        </CardBody>
      ) : rows.length === 0 ? (
        <EmptyState
          title="Серверов пока нет."
          description="Статус-канал назначается серверу — добавьте сервер, и он появится здесь."
        />
      ) : (
        <ul className="divide-y divide-line">
          {rows.map((row) => {
            const preview = statusChannelPreview(drafts[row.server_id]?.trim() || null);
            return (
              <li key={row.server_id} className="flex flex-wrap items-center gap-2 p-3">
                <span className="min-w-[140px] text-ink">{row.display_name}</span>
                {/* Ширину задаёт обёртка: сам `TextInput` тянется на 100%
                    родителя, и `w-48` на нём не выиграет у `w-full`. */}
                <div className="w-56">
                  <TextInput
                    aria-label={`ID статус-канала для ${row.display_name}`}
                    value={drafts[row.server_id] ?? ''}
                    onChange={(e) => setDrafts((d) => ({ ...d, [row.server_id]: e.target.value }))}
                    placeholder="ID канала"
                    className="font-mono"
                  />
                </div>
                <Button
                  variant="secondary"
                  aria-label={`Сохранить статус-канал ${row.display_name}`}
                  disabled={busy === row.server_id}
                  loading={busy === row.server_id}
                  onClick={() => void save(row)}
                >
                  Сохранить
                </Button>
                {preview && <span className="text-xs text-ink-3">→ {preview}</span>}
                {saved === row.server_id && <span className="text-xs text-good">Сохранено</span>}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
