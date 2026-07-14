'use client';

import { useEffect, useId, useState } from 'react';

interface ServerSummary {
  id: string;
  display_name: string;
}

interface ServersResponse {
  items: ServerSummary[];
}

export interface ExternalBanLocalBanTarget {
  id: string;
  sourceName: string;
  reason: string | null;
}

interface ExternalBanLocalBanModalProps {
  playerId: string;
  target: ExternalBanLocalBanTarget | null;
  onClose: () => void;
  onBanned: (serverName: string) => void;
}

/**
 * CBAN-4 confirmation form for turning an active external-ban match into a
 * local Squad ban. It preloads the external source/reason, requires an
 * explicit server choice, and submits through the audited AdminBan API.
 */
export function ExternalBanLocalBanModal({
  playerId,
  target,
  onClose,
  onBanned,
}: ExternalBanLocalBanModalProps) {
  const titleId = useId();
  const [servers, setServers] = useState<ServerSummary[]>([]);
  const [serverId, setServerId] = useState('');
  const [reason, setReason] = useState('');
  const [banLength, setBanLength] = useState('0');
  const [loadingServers, setLoadingServers] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!target) return;
    let cancelled = false;
    setReason(`${target.sourceName}: ${target.reason ?? 'внешний бан'}`.slice(0, 300));
    setBanLength('0');
    setServerId('');
    setServers([]);
    setError(null);
    setLoadingServers(true);

    fetch('/api/v1/servers', { credentials: 'include', cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return (await response.json()) as ServersResponse;
      })
      .then((body) => {
        if (cancelled) return;
        setServers(body.items);
        setServerId(body.items[0]?.id ?? '');
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(`Не удалось загрузить серверы: ${(cause as Error).message}`);
      })
      .finally(() => {
        if (!cancelled) setLoadingServers(false);
      });

    return () => {
      cancelled = true;
    };
  }, [target]);

  if (!target) return null;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!target || !serverId) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/v1/players/${playerId}/external-bans/${target.id}/local-ban`,
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            server_id: serverId,
            reason: reason.trim(),
            ban_length: banLength.trim() || '0',
          }),
        },
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `HTTP ${response.status}`);
      }
      const serverName = servers.find((server) => server.id === serverId)?.display_name ?? serverId;
      onBanned(serverName);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
    >
      <form
        onSubmit={submit}
        className="w-full max-w-lg space-y-4 rounded border border-neutral-700 bg-neutral-950 p-5 shadow-xl"
      >
        <div>
          <h3 id={titleId} className="text-lg font-semibold text-neutral-100">
            Забанить локально
          </h3>
          <p className="mt-1 text-xs text-neutral-400">
            Источник: {target.sourceName}. Команда AdminBan будет отправлена на выбранный сервер.
          </p>
        </div>

        <label className="block space-y-1 text-sm text-neutral-300">
          <span>Сервер</span>
          <select
            value={serverId}
            onChange={(event) => setServerId(event.target.value)}
            disabled={loadingServers || servers.length === 0 || submitting}
            required
            className="w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2"
          >
            {servers.length === 0 ? <option value="">Серверы недоступны</option> : null}
            {servers.map((server) => (
              <option key={server.id} value={server.id}>
                {server.display_name}
              </option>
            ))}
          </select>
        </label>

        <label className="block space-y-1 text-sm text-neutral-300">
          <span>Причина</span>
          <textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            required
            maxLength={300}
            disabled={submitting}
            rows={3}
            className="w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2"
          />
        </label>

        <label className="block space-y-1 text-sm text-neutral-300">
          <span>Срок (`0` — навсегда, например `7d`)</span>
          <input
            value={banLength}
            onChange={(event) => setBanLength(event.target.value)}
            required
            pattern="\d+[smhdwMy]?"
            disabled={submitting}
            className="w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 font-mono"
          />
        </label>

        {error ? (
          <div className="rounded border border-red-900 bg-red-950 p-2 text-xs text-red-200">
            Ошибка: {error}
          </div>
        ) : null}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded border border-neutral-700 px-3 py-2 text-sm text-neutral-300"
          >
            Отмена
          </button>
          <button
            type="submit"
            disabled={loadingServers || !serverId || !reason.trim() || submitting}
            className="rounded border border-red-800 bg-red-950 px-3 py-2 text-sm text-red-200 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting ? 'Бан…' : 'Забанить'}
          </button>
        </div>
      </form>
    </div>
  );
}
