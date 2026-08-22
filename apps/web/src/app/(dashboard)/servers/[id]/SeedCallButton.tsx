'use client';

import { useEffect, useState } from 'react';
import { Button, Card, CardBody, CardHeader, InlineBanner } from '@/components/ui';

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
    <Card padding="none" as="section">
      <CardHeader
        title="Нужен сид"
        description="Уведомить подписчиков и отправить событие в Discord. Не чаще одного раза в 2 часа."
        actions={
          <Button
            variant="primary"
            onClick={() => void callSeeders()}
            disabled={busy || remaining > 0}
            loading={busy}
          >
            {busy
              ? 'Отправляю…'
              : remaining > 0
                ? `Повторить через ${formatCooldown(remaining)}`
                : 'Позвать сидеров'}
          </Button>
        }
      />
      {message ? (
        <CardBody>
          <InlineBanner tone="info" title={message} />
        </CardBody>
      ) : null}
    </Card>
  );
}
