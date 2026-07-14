'use client';

import { useCallback, useEffect, useState } from 'react';

type SeedChannel = 'email' | 'webpush';

interface ServerItem {
  id: string;
  display_name: string;
  status: string;
}

interface Subscription {
  server_id: string;
  server_name: string;
  channel: SeedChannel;
}

const CHANNELS: ReadonlyArray<{ value: SeedChannel; label: string }> = [
  { value: 'webpush', label: 'Web Push' },
  { value: 'email', label: 'Email' },
];

export default function SeedNotificationsPage() {
  const [servers, setServers] = useState<ServerItem[]>([]);
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [serversResponse, subscriptionsResponse] = await Promise.all([
        fetch('/api/v1/servers', { credentials: 'include', cache: 'no-store' }),
        fetch('/api/v1/seed-subscriptions', { credentials: 'include', cache: 'no-store' }),
      ]);
      if (!serversResponse.ok) throw new Error(`HTTP ${serversResponse.status}`);
      if (!subscriptionsResponse.ok) throw new Error(`HTTP ${subscriptionsResponse.status}`);
      const serverBody = (await serversResponse.json()) as { items: ServerItem[] };
      const subscriptionBody = (await subscriptionsResponse.json()) as {
        subscriptions: Subscription[];
      };
      setServers(serverBody.items);
      setSubscriptions(subscriptionBody.subscriptions);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function isSubscribed(serverId: string, channel: SeedChannel): boolean {
    return subscriptions.some((item) => item.server_id === serverId && item.channel === channel);
  }

  async function toggle(serverId: string, channel: SeedChannel) {
    const key = `${serverId}:${channel}`;
    setBusy(key);
    setError(null);
    const enabled = !isSubscribed(serverId, channel);
    try {
      const response = await fetch(`/api/v1/servers/${serverId}/seed-subscription`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel, enabled }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setSubscriptions((current) =>
        enabled
          ? [...current, { server_id: serverId, server_name: '', channel }]
          : current.filter((item) => !(item.server_id === serverId && item.channel === channel)),
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (loading) return <div className="text-neutral-500">Загрузка…</div>;

  return (
    <div className="max-w-3xl space-y-4 pb-20">
      <header>
        <h1 className="text-xl font-semibold">Уведомления «Нужен сид»</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Выберите серверы и каналы, в которых хотите получать приглашения на сидинг.
        </p>
      </header>
      {error ? (
        <div className="rounded border border-red-900 bg-red-950 px-3 py-2 text-sm">{error}</div>
      ) : null}
      <div className="divide-y divide-neutral-800 rounded border border-neutral-800 bg-neutral-950">
        {servers.map((server) => (
          <div key={server.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div>
              <div className="font-medium">{server.display_name}</div>
              <div className="text-xs text-neutral-500">{server.status}</div>
            </div>
            <div className="flex gap-4 text-sm">
              {CHANNELS.map((channel) => {
                const key = `${server.id}:${channel.value}`;
                return (
                  <label key={channel.value} className="flex items-center gap-2 text-neutral-300">
                    <input
                      type="checkbox"
                      checked={isSubscribed(server.id, channel.value)}
                      disabled={busy === key}
                      onChange={() => void toggle(server.id, channel.value)}
                    />
                    {channel.label}
                  </label>
                );
              })}
            </div>
          </div>
        ))}
        {servers.length === 0 ? (
          <p className="p-4 text-sm text-neutral-500">Нет серверов.</p>
        ) : null}
      </div>
    </div>
  );
}
