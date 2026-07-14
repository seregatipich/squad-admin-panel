'use client';

import { useEffect, useState } from 'react';

interface SeedCallStatus {
  available: boolean;
  retry_after: number;
  join_link: string | null;
}

export function formatCooldown(seconds: number): string {
  const minutes = Math.floor(Math.max(0, seconds) / 60);
  const remainingSeconds = Math.max(0, seconds) % 60;
  return `${minutes}:${String(remainingSeconds).padStart(2, '0')}`;
}

export function SeedCallButton({ serverId, canCall }: { serverId: string; canCall: boolean }) {
  const [remaining, setRemaining] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!canCall) return;
    let cancelled = false;
    void fetch(`/api/v1/servers/${serverId}/seed-call`, {
      credentials: 'include',
      cache: 'no-store',
    }).then(async (response) => {
      if (!response.ok || cancelled) return;
      const status = (await response.json()) as SeedCallStatus;
      if (!cancelled) setRemaining(status.retry_after);
    });
    return () => {
      cancelled = true;
    };
  }, [canCall, serverId]);

  useEffect(() => {
    if (remaining <= 0) return;
    const timer = setInterval(() => setRemaining((value) => Math.max(0, value - 1)), 1000);
    return () => clearInterval(timer);
  }, [remaining]);

  async function callSeeders() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/v1/servers/${serverId}/seed-call`, {
        method: 'POST',
        credentials: 'include',
      });
      const body = (await response.json().catch(() => ({}))) as {
        retry_after?: number;
        error?: string;
      };
      if (response.status === 429) {
        const retryAfter =
          body.retry_after ?? (Number(response.headers.get('Retry-After')) || 7200);
        setRemaining(retryAfter);
        setMessage(`Повторить через ${formatCooldown(retryAfter)}`);
        return;
      }
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      setRemaining(body.retry_after ?? 7200);
      setMessage('Сидеры уведомлены');
    } catch (error) {
      setMessage(`Не удалось отправить: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  if (!canCall) return null;

  return (
    <section className="rounded border border-amber-900 bg-amber-950/30 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-amber-200">Нужен сид</h2>
          <p className="mt-1 text-xs text-neutral-400">
            Уведомить подписчиков и отправить событие в Discord. Не чаще одного раза в 2 часа.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void callSeeders()}
          disabled={busy || remaining > 0}
          className="rounded border border-amber-700 bg-amber-700/70 px-3 py-1.5 text-sm text-amber-50 hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy
            ? 'Отправляю…'
            : remaining > 0
              ? `Повторить через ${formatCooldown(remaining)}`
              : 'Позвать сидеров'}
        </button>
      </div>
      {message ? <p className="mt-2 text-xs text-neutral-300">{message}</p> : null}
    </section>
  );
}
