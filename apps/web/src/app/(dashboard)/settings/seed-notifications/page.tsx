'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Button,
  Card,
  Checkbox,
  EmptyState,
  GroupedList,
  GroupedRow,
  InlineBanner,
  PageHeader,
  Skeleton,
} from '@/components/ui';
import { apiFetch, apiSend } from '@/lib/api';
import { describeLoadError } from '@/lib/load-error';

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
      const [serverBody, subscriptionBody] = await Promise.all([
        apiFetch<{ items: ServerItem[] }>('/api/v1/servers'),
        apiFetch<{ subscriptions: Subscription[] }>('/api/v1/seed-subscriptions'),
      ]);
      setServers(serverBody.items);
      setSubscriptions(subscriptionBody.subscriptions);
    } catch (err) {
      setError(describeLoadError(err));
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
      await apiSend(`/api/v1/servers/${serverId}/seed-subscription`, {
        method: 'PUT',
        json: { channel, enabled },
      });
      setSubscriptions((current) =>
        enabled
          ? [...current, { server_id: serverId, server_name: '', channel }]
          : current.filter((item) => !(item.server_id === serverId && item.channel === channel)),
      );
    } catch (err) {
      setError(describeLoadError(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <PageHeader
        title="Уведомления «Нужен сид»"
        subtitle="Выберите серверы и каналы, в которых хотите получать приглашения на сидинг."
      />

      {error ? (
        <InlineBanner
          tone="crit"
          title={error}
          description="Подписки могли не сохраниться. Обновите список и повторите."
          action={
            <Button size="sm" onClick={() => void load()}>
              Повторить
            </Button>
          }
        />
      ) : null}

      {loading ? (
        <Card>
          <Skeleton variant="row" count={4} label="Загрузка списка серверов" />
        </Card>
      ) : servers.length === 0 ? (
        <Card>
          <EmptyState
            title="Серверов пока нет"
            description="Подписаться на приглашения к сидингу можно, когда в панели появится хотя бы один сервер."
          />
        </Card>
      ) : (
        <GroupedList footnote="Подписка включается сразу — отдельной кнопки «Сохранить» здесь нет.">
          {servers.map((server) => (
            <GroupedRow
              key={server.id}
              label={server.display_name}
              description={server.status}
              control={
                <span className="flex items-center gap-4">
                  {CHANNELS.map((channel) => (
                    <Checkbox
                      key={channel.value}
                      label={channel.label}
                      checked={isSubscribed(server.id, channel.value)}
                      disabled={busy === `${server.id}:${channel.value}`}
                      onChange={() => void toggle(server.id, channel.value)}
                    />
                  ))}
                </span>
              }
            />
          ))}
        </GroupedList>
      )}
    </>
  );
}
