'use client';
import { useBridgeState, useLiveBusState } from '@/lib/use-live-bus';

export function ConnectionBanner() {
  const wsState = useLiveBusState();
  const bridgeState = useBridgeState();
  if (wsState === 'open' && bridgeState !== 'down') return null;
  let message = '';
  let tone = 'bg-yellow-500/15 text-yellow-200 border-yellow-500/30';
  if (wsState !== 'open') {
    message = 'Связь с панелью потеряна — переподключаемся…';
    tone = 'bg-red-500/15 text-red-200 border-red-500/30';
  } else if (bridgeState === 'down') {
    message = 'Bridge не отвечает — операции с сервером временно недоступны';
    tone = 'bg-yellow-500/15 text-yellow-200 border-yellow-500/30';
  }
  return (
    <div
      role="alert"
      data-testid="connection-banner"
      className={`sticky top-0 z-50 border-b px-4 py-2 text-sm ${tone}`}
    >
      {message}
    </div>
  );
}
