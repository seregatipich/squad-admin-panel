'use client';

import { useCallback, useState } from 'react';
import { Card, CloseIcon, IconButton } from '@/components/ui';
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
 *
 * Позицию задаёт общая область `ToastRegion` в layout панели, поэтому здесь
 * остаётся только `pointer-events-auto` — область намеренно не перехватывает
 * указатель, и вернуть перехват обязано каждое уведомление.
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
    <output className="pointer-events-auto block w-80">
      <Card>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[13px] font-semibold text-ink">
              VIP истекает через {notification.windowDays} дн.
            </p>
            <p className="mt-1 text-xs text-ink-3">
              {notification.playerName} — {notification.roleName}
            </p>
          </div>
          <IconButton
            icon={<CloseIcon />}
            label="Закрыть уведомление об истечении VIP"
            onClick={() => setNotification(null)}
            className="-mr-1 -mt-1 shrink-0"
          />
        </div>
      </Card>
    </output>
  );
}
