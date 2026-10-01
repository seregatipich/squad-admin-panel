'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { InlineBanner } from '@/components/ui/InlineBanner';
import { ApiError, apiSend } from '@/lib/api';
import { useApiResource } from '@/lib/use-polled-resource';

interface AdminsCfgStatus {
  state: 'unknown' | 'in_sync' | 'drift' | 'unreachable' | 'syncing';
  last_synced_at: string | null;
  last_segment_hash: string | null;
  last_db_hash: string | null;
  groups_count?: number;
  admins_count?: number;
  error?: string | null;
  /** ISO timestamp of when the bridge first failed in the current
   *  outage window. Used to compute "Server X не получил последние
   *  изменений Admins.cfg" alert per spec §2.7.7. */
  unreachable_since?: string | null;
}

interface DriftResponse {
  server_id: string;
  status: AdminsCfgStatus;
}

const POLL_MS = 30_000;
const SYNC_REFRESH_DELAY_MS = 1_500;
// The caller lacks `admin_group:view` (or the endpoint is absent): polling again cannot succeed.
const TERMINAL_STATUSES = new Set([401, 403, 404]);
// Spec §2.7.7 — surface long-outage alert after this duration.
const LONG_OUTAGE_MS = 60 * 60_000;
// Suppress the unreachable banner for short outages — bridge-client retries
// transport errors transparently and the worker reclaim loop replays unacked
// messages within ~60s. Showing the banner before that just produces flicker
// during routine bridge restarts.
const UNREACHABLE_DEBOUNCE_MS = 30_000;

function formatOutageDuration(unreachableSince: string): string {
  const ms = Date.now() - new Date(unreachableSince).getTime();
  if (ms < 60 * 60_000) {
    const minutes = Math.max(1, Math.floor(ms / 60_000));
    return minutes === 1 ? `${minutes} минуту` : `${minutes} минут`;
  }
  const hours = Math.floor(ms / (60 * 60_000));
  if (hours < 24) {
    return hours === 1 ? `${hours} час` : `${hours} часов`;
  }
  const days = Math.floor(hours / 24);
  return days === 1 ? `${days} день` : `${days} дней`;
}

/**
 * Warns when Admins.cfg on a server drifted from the panel or is unreachable.
 *
 * @param serverId Server whose drift status is polled.
 * @param canSync Whether the viewer holds `admin_group:edit`, which the sync
 *   endpoint requires; without it the banner informs but offers no button.
 */
export function AdminsCfgDriftBanner({
  serverId,
  canSync,
}: {
  serverId: string;
  canSync: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { data, error, refresh } = useApiResource<DriftResponse>(
    `/api/v1/admins-cfg/drift?server_id=${serverId}`,
    {
      intervalMs: POLL_MS,
      pauseWhenHidden: true,
      stopPolling: (e) => e instanceof ApiError && TERMINAL_STATUSES.has(e.status),
    },
  );
  // An error answer clears the banner; a network blip keeps the last known status.
  const status = error instanceof ApiError ? null : (data?.status ?? null);

  useEffect(
    () => () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    },
    [],
  );

  async function forceSync() {
    setBusy(true);
    setErr(null);
    try {
      await apiSend(`/api/v1/admins-cfg/sync?server_id=${serverId}`, { method: 'POST' });
      // Worker will pick up; refresh shortly.
      refreshTimer.current = setTimeout(() => void refresh(), SYNC_REFRESH_DELAY_MS);
    } catch (e) {
      setErr(e instanceof ApiError ? `Ошибка: ${e.codeOrStatus()}` : 'Не удалось связаться с API');
    } finally {
      setBusy(false);
    }
  }

  if (!status) return null;
  const isUnreachable = status.state === 'unreachable';

  if (status.state !== 'drift' && !isUnreachable) return null;

  if (isUnreachable) {
    const since = status.unreachable_since ? new Date(status.unreachable_since).getTime() : null;
    if (since === null || Date.now() - since < UNREACHABLE_DEBOUNCE_MS) {
      return null;
    }
    const longOutage = Date.now() - since >= LONG_OUTAGE_MS;
    return (
      <InlineBanner
        tone="warn"
        title={
          longOutage
            ? `Сервер не получает изменения Admins.cfg уже ${formatOutageDuration(
                status.unreachable_since as string,
              )}`
            : 'Admins.cfg недоступен на этом сервере'
        }
        description={
          <>
            {status.error ?? 'bridge вернул ошибку при чтении файла.'}
            {err ? <span className="mt-1 block text-crit">{err}</span> : null}
          </>
        }
        action={
          canSync ? (
            <Button size="sm" onClick={forceSync} loading={busy}>
              Повторить синхронизацию
            </Button>
          ) : undefined
        }
      />
    );
  }

  return (
    <InlineBanner
      tone="warn"
      title="Admins.cfg на этом сервере изменён вне панели"
      description={
        <>
          Управляемый сегмент в файле не совпадает с базой панели. Синхронизация перезапишет сегмент
          в файле данными из панели.
          {err ? <span className="mt-1 block text-crit">{err}</span> : null}
        </>
      }
      action={
        canSync ? (
          <Button size="sm" onClick={forceSync} loading={busy}>
            Синхронизировать
          </Button>
        ) : undefined
      }
    />
  );
}
