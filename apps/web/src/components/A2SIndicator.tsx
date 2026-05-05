'use client';

interface Props {
  a2sStatus: {
    visible: boolean;
    server_name?: string;
    latency_ms?: number;
    reason?: string;
  } | null;
  serverStatus: string;
}

export function A2SIndicator({ a2sStatus, serverStatus }: Props) {
  if (!['running', 'starting'].includes(serverStatus)) return null;
  if (!a2sStatus) return null;

  const visible = a2sStatus.visible;

  return (
    <span
      title={
        visible
          ? `Виден в Steam Browser (${a2sStatus.latency_ms ?? '?'}ms)`
          : `Не виден в Steam Browser${a2sStatus.reason ? `: ${a2sStatus.reason}` : ''}`
      }
      className={`inline-flex items-center gap-1 text-xs ${visible ? 'text-emerald-400' : 'text-red-400'}`}
    >
      <svg
        viewBox="0 0 16 16"
        className="h-3.5 w-3.5 fill-current"
        role="img"
        aria-label="Steam visibility"
      >
        <title>Steam visibility</title>
        <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M2 8 A6 6 0 0 1 14 8" fill="none" stroke="currentColor" strokeWidth="1" />
        <path d="M4 4 A6 3 0 0 1 12 4" fill="none" stroke="currentColor" strokeWidth="0.8" />
        <line x1="8" y1="1" x2="8" y2="15" stroke="currentColor" strokeWidth="1" />
        <line x1="1" y1="8" x2="15" y2="8" stroke="currentColor" strokeWidth="1" />
      </svg>
      {visible ? 'Steam' : '!Steam'}
    </span>
  );
}
