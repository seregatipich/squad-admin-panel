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
  emerald: 'bg-good',
  amber: 'bg-warn',
  red: 'bg-crit',
  neutral: 'bg-ink-4',
};

const TEXT_CLASS: Record<LiveTone, string> = {
  emerald: 'text-good',
  amber: 'text-warn',
  red: 'text-crit',
  neutral: 'text-ink-3',
};

/**
 * Пилюля свежести данных: точка состояния плюс возраст последнего ответа.
 *
 * Пульсирует только свежее состояние — по дизайн-системе (§9) пульсация
 * означает «данные идут прямо сейчас». Застоявшийся и оборвавшийся опрос
 * стоят неподвижно: движение там сообщало бы ровно обратное тому, что есть.
 * Состояние никогда не кодируется одним цветом — возраст всегда написан
 * текстом рядом с точкой (§5).
 */
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
      className={`inline-flex items-center gap-1.5 rounded-full border border-line bg-bg/80 px-2 py-0.5 text-2xs ${TEXT_CLASS[tone]}`}
      title={tooltip}
    >
      <span
        aria-hidden
        className={`inline-block h-1.5 w-1.5 rounded-full ${DOT_CLASS[tone]} ${
          tone === 'emerald' ? 'animate-pulse' : ''
        }`}
      />
      <span>{text}</span>
    </span>
  );
}
