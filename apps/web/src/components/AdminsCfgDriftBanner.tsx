'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { InlineBanner } from '@/components/ui/InlineBanner';

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

export function AdminsCfgDriftBanner({ serverId }: { serverId: string }) {
  const [status, setStatus] = useState<AdminsCfgStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/v1/admins-cfg/drift?server_id=${serverId}`, {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!r.ok) {
        setStatus(null);
        return;
      }
      const j = (await r.json()) as DriftResponse;
      setStatus(j.status);
    } catch {
      // network blip; keep last known
    }
  }, [serverId]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  async function forceSync() {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/v1/admins-cfg/sync?server_id=${serverId}`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}) as Record<string, unknown>);
        setErr(`Ошибка: ${e.error ?? r.status}`);
        return;
      }
      // Worker will pick up; refresh shortly.
      setTimeout(() => void load(), 1500);
    } finally {
      setBusy(false);
    }
  }

  if (!status) return null;
  const isUnreachable = status.state === 'unreachable';
  const lastSegHash = status.last_segment_hash;
  const dbHash = status.last_db_hash;
  const driftDetected =
    status.state === 'drift' ||
    (!isUnreachable && lastSegHash != null && dbHash != null && lastSegHash !== dbHash);

  if (status.state === 'in_sync' || status.state === 'syncing' || status.state === 'unknown') {
    return null;
  }

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
        description={status.error ?? 'bridge вернул ошибку при чтении файла.'}
        action={
          <Button size="sm" onClick={forceSync} loading={busy}>
            Повторить синхронизацию
          </Button>
        }
      />
    );
  }

  if (driftDetected) {
    return (
      <InlineBanner
        tone="warn"
        title="Admins.cfg на этом сервере изменён вне панели"
        description={
          <>
            Управляемый сегмент в файле не совпадает с базой панели. Синхронизация перезапишет
            сегмент в файле данными из панели.
            {err ? <span className="mt-1 block text-crit">{err}</span> : null}
          </>
        }
        action={
          <Button size="sm" onClick={forceSync} loading={busy}>
            Синхронизировать
          </Button>
        }
      />
    );
  }

  return null;
}
