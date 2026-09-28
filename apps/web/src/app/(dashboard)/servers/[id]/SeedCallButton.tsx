'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Card, CardBody, CardHeader, InlineBanner } from '@/components/ui';

interface SeedCallStatus {
  available: boolean;
  retry_after: number;
  join_link: string | null;
}

/** Machine-readable POST /seed-call error codes mapped to a Russian message (UI is Russian-only). */
const SEED_CALL_ERROR_LABEL: Record<string, string> = {
  forbidden: 'Недостаточно прав для вызова сидеров',
  host_unavailable: 'Хост сервера недоступен',
  not_found: 'Сервер не найден',
  bad_request: 'Некорректный запрос',
};

function seedCallErrorMessage(code: unknown): string {
  if (typeof code === 'string' && code in SEED_CALL_ERROR_LABEL) {
    return SEED_CALL_ERROR_LABEL[code] as string;
  }
  return 'Не удалось отправить запрос';
}

export function formatCooldown(seconds: number): string {
  const minutes = Math.floor(Math.max(0, seconds) / 60);
  const remainingSeconds = Math.max(0, seconds) % 60;
  return `${minutes}:${String(remainingSeconds).padStart(2, '0')}`;
}

export function SeedCallButton({ serverId, canCall }: { serverId: string; canCall: boolean }) {
  const [remaining, setRemaining] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'info' | 'crit'; text: string } | null>(null);
  // Wall-clock deadline (not a tick count) so the countdown survives a
  // throttled background tab and this component never needs to recreate its
  // interval on every second — only when the cooldown starts or ends.
  const deadlineRef = useRef<number | null>(null);

  /** Starts (or clears, for `seconds <= 0`) the cooldown countdown toward a fixed deadline. */
  const applyCooldown = useCallback((seconds: number) => {
    const clamped = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
    deadlineRef.current = clamped > 0 ? Date.now() + clamped * 1000 : null;
    setRemaining(clamped);
  }, []);

  useEffect(() => {
    if (!canCall) return;
    let cancelled = false;
    fetch(`/api/v1/servers/${serverId}/seed-call`, {
      credentials: 'include',
      cache: 'no-store',
    })
      .then(async (response) => {
        if (!response.ok || cancelled) return;
        const status = (await response.json()) as SeedCallStatus;
        if (cancelled) return;
        applyCooldown(typeof status.retry_after === 'number' ? status.retry_after : 0);
      })
      .catch(() => {
        // Best-effort prefetch of the cooldown state — a network error here
        // just leaves the button enabled; the POST below still enforces it.
      });
    return () => {
      cancelled = true;
    };
  }, [canCall, serverId, applyCooldown]);

  const hasCooldown = remaining > 0;
  useEffect(() => {
    if (!hasCooldown) return;
    const timer = setInterval(() => {
      const deadline = deadlineRef.current;
      if (deadline === null) return;
      setRemaining(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    }, 1000);
    return () => clearInterval(timer);
  }, [hasCooldown]);

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
          typeof body.retry_after === 'number'
            ? body.retry_after
            : Number(response.headers.get('Retry-After')) || 7200;
        applyCooldown(retryAfter);
        setMessage({ tone: 'info', text: `Повторить через ${formatCooldown(retryAfter)}` });
        return;
      }
      if (!response.ok) {
        setMessage({
          tone: 'crit',
          text: `Не удалось отправить: ${seedCallErrorMessage(body.error)}`,
        });
        return;
      }
      applyCooldown(typeof body.retry_after === 'number' ? body.retry_after : 7200);
      setMessage({ tone: 'info', text: 'Сидеры уведомлены' });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setMessage({ tone: 'crit', text: `Не удалось отправить: ${detail}` });
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
          <InlineBanner tone={message.tone} title={message.text} />
        </CardBody>
      ) : null}
    </Card>
  );
}
