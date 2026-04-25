'use client';
import { useEffect, useState } from 'react';

export type LiveTone = 'emerald' | 'amber' | 'red' | 'neutral';

export function liveTone(ageMs: number | null): LiveTone {
  if (ageMs === null || !Number.isFinite(ageMs) || ageMs < 0) return 'neutral';
  if (ageMs < 10_000) return 'emerald';
  if (ageMs < 60_000) return 'amber';
  return 'red';
}

const DOT_CLASS: Record<LiveTone, string> = {
  emerald: 'bg-green-500',
  amber: 'bg-amber-500',
  red: 'bg-red-600',
  neutral: 'bg-neutral-600',
};

const TEXT_CLASS: Record<LiveTone, string> = {
  emerald: 'text-emerald-300',
  amber: 'text-amber-300',
  red: 'text-red-300',
  neutral: 'text-neutral-500',
};

export function LiveIndicator({
  lastUpdate,
  label = 'обновлено',
  title,
}: {
  lastUpdate: Date | number | null;
  label?: string;
  title?: string;
}) {
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const ts = lastUpdate instanceof Date ? lastUpdate.getTime() : lastUpdate;
  const ageMs = ts === null ? null : Math.max(0, now - ts);
  const tone = liveTone(ageMs);
  const ageSec = ageMs === null ? null : Math.floor(ageMs / 1000);
  const text = ageSec === null ? `${label} —` : `${label} ${ageSec}с назад`;
  const tooltip =
    title ??
    (ageSec === null
      ? 'данных пока нет'
      : tone === 'red'
        ? `опрос завис (${ageSec}с без ответа)`
        : `последнее обновление ${ageSec}с назад`);

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border border-neutral-800 bg-neutral-950/80 px-2 py-0.5 text-[10px] ${TEXT_CLASS[tone]}`}
      title={tooltip}
    >
      <span
        className={`inline-block h-1.5 w-1.5 rounded-full ${DOT_CLASS[tone]} ${
          tone === 'red' || tone === 'neutral' ? '' : 'animate-pulse'
        }`}
      />
      <span>{text}</span>
    </span>
  );
}
