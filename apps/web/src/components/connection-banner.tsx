'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslator } from '@/i18n/LocaleProvider';
import { getLiveBus } from '@/lib/live-bus';

// Minimal connectivity indicator. We do NOT render an alarming sticky
// banner anymore — historical "Связь с панелью потеряна" alerts fired
// on every WebSocket hiccup and blocked the UI for users whose only
// problem was the realtime channel optimization, while HTTP polling
// (which is the actual panel data path) was perfectly fine.
//
// Behavior now:
//   - On mount, fire-and-forget retain on the live bus (so the WS
//     opens if it's going to). Do not visualise the WS state.
//   - Probe `/api/v1/me` once per minute. If it consistently fails
//     for more than a minute, render a small bottom-right toast that
//     can be dismissed but does not block the UI.
//   - Never sticky-block the top of the page.

const HTTP_PROBE_INTERVAL_MS = 30_000;
// Require this many consecutive failures before showing anything.
const FAIL_THRESHOLD = 2;

export function ConnectionBanner() {
  const t = useTranslator();
  const [hydrated, setHydrated] = useState(false);
  const [reachable, setReachable] = useState(true);
  const [dismissed, setDismissed] = useState(false);
  const failCount = useRef(0);
  const probeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busReleaseRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    setHydrated(true);
    if (typeof window !== 'undefined') {
      busReleaseRef.current = getLiveBus().retain();
    }
    return () => {
      busReleaseRef.current?.();
      busReleaseRef.current = null;
    };
  }, []);

  const probe = useCallback(async () => {
    try {
      const res = await fetch('/api/v1/me', {
        credentials: 'include',
        cache: 'no-store',
      });
      if (res.ok) {
        failCount.current = 0;
        setReachable(true);
        setDismissed(false);
      } else {
        failCount.current += 1;
        if (failCount.current >= FAIL_THRESHOLD) setReachable(false);
      }
    } catch {
      failCount.current += 1;
      if (failCount.current >= FAIL_THRESHOLD) setReachable(false);
    }
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    const tick = async () => {
      await probe();
      probeTimer.current = setTimeout(tick, HTTP_PROBE_INTERVAL_MS);
    };
    probeTimer.current = setTimeout(tick, HTTP_PROBE_INTERVAL_MS);
    return () => {
      if (probeTimer.current) clearTimeout(probeTimer.current);
      probeTimer.current = null;
    };
  }, [hydrated, probe]);

  if (!hydrated) return null;
  if (reachable || dismissed) return null;

  return (
    <div
      role="alert"
      data-testid="connection-banner"
      className="pointer-events-auto flex items-center gap-2 rounded-card border border-crit/40 bg-surface px-3 py-2 text-xs text-ink shadow-xl shadow-black/40 backdrop-blur-xl"
    >
      <span>{t('connection.unavailable')}</span>
      <button
        type="button"
        onClick={() => {
          failCount.current = 0;
          void probe();
        }}
        className="h-7 rounded-ctl border border-line bg-raised px-2.5 text-2xs font-medium text-ink transition-colors hover:bg-line-2"
      >
        {t('connection.retry')}
      </button>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        className="grid h-7 w-7 shrink-0 place-items-center rounded-ctl text-ink-3 transition-colors hover:bg-raised hover:text-ink"
        aria-label={t('connection.dismiss')}
        title={t('connection.dismiss')}
      >
        <span aria-hidden>✕</span>
      </button>
    </div>
  );
}
