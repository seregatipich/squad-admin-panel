'use client';

import { useCallback, useState } from 'react';
import { Card, CloseIcon, IconButton } from '@/components/ui';
import type { LiveEvent } from '@/lib/live-bus';
import { useLiveSubscription } from '@/lib/use-live-bus';

type AlertTriggeredEvent = Extract<LiveEvent, { type: 'alert.triggered' }>;

interface SeedNotification {
  message: string;
  serverName: string;
  joinLink: string;
}

const STEAM_JOIN_LINK = /^steam:\/\/connect\/\S+:\d{1,5}$/;

function readSeedNotification(event: AlertTriggeredEvent): SeedNotification | null {
  const { data } = event;
  if (data.channel !== 'webpush') return null;
  if (data.event_kind !== 'seed.call_sent' && data.event_kind !== 'server.seeding_started') {
    return null;
  }
  if (typeof data.server_name !== 'string' || data.server_name.length === 0) return null;
  if (typeof data.join_link !== 'string' || !STEAM_JOIN_LINK.test(data.join_link)) return null;

  return {
    message:
      typeof data.message === 'string' && data.message.length > 0 ? data.message : 'Нужен сид',
    serverName: data.server_name,
    joinLink: data.join_link,
  };
}

/**
 * Shows recipient-scoped seed alerts delivered over the panel live bus.
 *
 * Позицию задаёт общая область `ToastRegion` в layout панели; уведомление
 * возвращает себе перехват указателя через `pointer-events-auto`.
 */
export function SeedNotificationToast() {
  const [notification, setNotification] = useState<SeedNotification | null>(null);

  const onAlert = useCallback((event: AlertTriggeredEvent) => {
    const next = readSeedNotification(event);
    if (next) setNotification(next);
  }, []);
  useLiveSubscription('alert.triggered', onAlert);

  if (!notification) return null;

  return (
    <output className="pointer-events-auto block w-80">
      <Card>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[13px] font-semibold text-ink">{notification.message}</p>
            <p className="mt-1 text-xs text-ink-3">{notification.serverName}</p>
          </div>
          <IconButton
            icon={<CloseIcon />}
            label="Закрыть уведомление"
            onClick={() => setNotification(null)}
            className="-mr-1 -mt-1 shrink-0"
          />
        </div>
        {/* Не `ButtonLink`: `steam://` — передача адреса игре, а не навигация
            внутри панели, и маршрутизатору Next такой адрес отдавать нечего. */}
        <a
          href={notification.joinLink}
          className="mt-3 inline-flex h-8 items-center justify-center rounded-ctl bg-accent px-3 text-xs font-medium text-bg no-underline transition-colors duration-150 hover:brightness-110"
        >
          Подключиться
        </a>
      </Card>
    </output>
  );
}
