'use client';

import { useCallback, useState } from 'react';
import type { LiveEvent } from '@/lib/live-bus';
import { useLiveSubscription } from '@/lib/use-live-bus';

type AlertTriggeredEvent = Extract<LiveEvent, { type: 'alert.triggered' }>;

interface RoleExpiryNotification {
  playerName: string;
  roleName: string;
  windowDays: number;
}

function readRoleExpiryNotification(event: AlertTriggeredEvent): RoleExpiryNotification | null {
  const { data } = event;
  if (data.event_kind !== 'role_expiring') return null;
  if (typeof data.player_name !== 'string' || data.player_name.length === 0) return null;
  if (typeof data.role_name !== 'string' || data.role_name.length === 0) return null;
  if (typeof data.window_days !== 'number') return null;

  return {
    playerName: data.player_name,
    roleName: data.role_name,
    windowDays: data.window_days,
  };
}

/**
 * VIPSUB-4 (#170): surfaces `role_expiring` reminder frames from the live bus.
 * The server only fans these frames out to sockets holding `can_assign_roles`
 * (`apps/api/src/routes/live.ts`); this client-side filter is defense-in-depth.
 */
export function RoleExpiryToast() {
  const [notification, setNotification] = useState<RoleExpiryNotification | null>(null);

  const onAlert = useCallback((event: AlertTriggeredEvent) => {
    const next = readRoleExpiryNotification(event);
    if (next) setNotification(next);
  }, []);
  useLiveSubscription('alert.triggered', onAlert);

  if (!notification) return null;

  return (
    <output className="fixed bottom-4 right-4 z-50 w-80 rounded border border-sky-800 bg-neutral-950 p-4 shadow-xl">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-semibold text-sky-200">
            VIP истекает через {notification.windowDays} дн.
          </p>
          <p className="mt-1 text-sm text-neutral-300">
            {notification.playerName} — {notification.roleName}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setNotification(null)}
          aria-label="Закрыть уведомление об истечении VIP"
          className="text-neutral-500 hover:text-neutral-200"
        >
          ×
        </button>
      </div>
    </output>
  );
}
