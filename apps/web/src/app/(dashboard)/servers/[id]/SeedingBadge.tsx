'use client';
import { useCallback, useState } from 'react';
import { Badge } from '@/components/ui';
import { useLiveSubscription } from '@/lib/use-live-bus';
import { clampProgressPct, formatSeedProgress, type SeedingSummary } from '../seeding-format';

interface SeedingLiveEvent {
  data: {
    server_id: string;
    state: 'seeding' | 'live';
    current_players: number;
    live_at: number;
    progress_pct: number;
    started_at: string | null;
  };
}

/**
 * Seeding badge + progress bar for the server detail page (SEED-1, #140).
 * Renders nothing when the server is not seeding (state 'live' or
 * 'unknown'/no data yet). Seeded with the server detail response's
 * `seeding` field and kept live via the `server.seeding` live-bus event, so
 * the progress bar advances without a page reload.
 */
export function SeedingBadge({
  serverId,
  initial,
}: {
  serverId: string;
  initial: SeedingSummary | null;
}) {
  const [summary, setSummary] = useState<SeedingSummary | null>(initial);

  const onSeeding = useCallback(
    (event: SeedingLiveEvent) => {
      if (event.data.server_id !== serverId) return;
      setSummary({
        state: event.data.state,
        current_players: event.data.current_players,
        live_at: event.data.live_at,
        progress_pct: event.data.progress_pct,
        started_at: event.data.started_at,
      });
    },
    [serverId],
  );
  useLiveSubscription('server.seeding', onSeeding);

  if (summary?.state !== 'seeding') return null;

  const progressPct = clampProgressPct(summary.progress_pct);
  const progressText = `${formatSeedProgress(summary.current_players, summary.live_at)} игроков до live`;

  return (
    <div className="flex items-center gap-2">
      <Badge tone="warn" size="sm">
        Сидинг
      </Badge>
      <div className="flex items-center gap-1.5">
        {/* Полоса дублируется текстом справа: состояние не кодируется одной
            только шириной заливки (§5). */}
        <div
          role="progressbar"
          aria-label="Прогресс сидинга"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progressPct}
          aria-valuetext={progressText}
          className="h-1.5 w-24 overflow-hidden rounded-full bg-raised"
        >
          <div
            className="h-full rounded-full bg-accent transition-all"
            style={{ width: `${progressPct}%` }}
          />
        </div>
        <span className="text-xs text-ink-3">{progressText}</span>
      </div>
    </div>
  );
}
