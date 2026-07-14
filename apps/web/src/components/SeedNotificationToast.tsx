'use client';

import { useCallback, useState } from 'react';
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

/** Shows recipient-scoped seed alerts delivered over the panel live bus. */
export function SeedNotificationToast() {
  const [notification, setNotification] = useState<SeedNotification | null>(null);

  const onAlert = useCallback((event: AlertTriggeredEvent) => {
    const next = readSeedNotification(event);
    if (next) setNotification(next);
  }, []);
  useLiveSubscription('alert.triggered', onAlert);

  if (!notification) return null;

  return (
    <output className="fixed bottom-4 right-4 z-50 w-80 rounded border border-amber-700 bg-neutral-950 p-4 shadow-xl">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-semibold text-amber-200">{notification.message}</p>
          <p className="mt-1 text-sm text-neutral-300">{notification.serverName}</p>
        </div>
        <button
          type="button"
          onClick={() => setNotification(null)}
          aria-label="Закрыть уведомление"
          className="text-neutral-500 hover:text-neutral-200"
        >
          ×
        </button>
      </div>
      <a
        href={notification.joinLink}
        className="mt-3 inline-flex rounded border border-amber-700 bg-amber-700/70 px-3 py-1.5 text-sm text-amber-50 hover:bg-amber-600"
      >
        Подключиться
      </a>
    </output>
  );
}
