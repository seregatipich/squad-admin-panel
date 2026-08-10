'use client';

import { useState } from 'react';

/**
 * Steam Web API snapshot as `GET /api/v1/players/:playerId` returns it
 * (INT-1 #76). Every field is optional so an older API build that predates the
 * columns still renders.
 */
export interface SteamSnapshot {
  avatar_url?: string | null;
  persona_name?: string | null;
  profile_visibility?: number | null;
  steam_account_created_at?: string | null;
  vac_banned?: boolean;
  vac_ban_count?: number;
  game_ban_count?: number;
  days_since_last_ban?: number | null;
  owns_squad?: boolean | null;
  steam_playtime_minutes?: number | null;
  steam_checked_at?: string | null;
}

const DASH = '—';

function refreshErrorMessage(status: number): string {
  if (status === 403) return 'Недостаточно прав';
  if (status === 409) return 'У игрока нет SteamID';
  if (status === 502) return 'Steam недоступен, попробуйте позже';
  if (status === 503) return 'Steam API не настроен';
  return `Ошибка HTTP ${status}`;
}

function ownershipLabel(ownsSquad: boolean | null | undefined): string {
  if (ownsSquad === true) return 'Да';
  if (ownsSquad === false) return 'Нет';
  return 'Скрыто';
}

/**
 * Steam block of the player card: VAC/game-ban state, Squad ownership and the
 * manual "refresh from Steam" action.
 *
 * A player without a SteamID64 can never carry Steam data, so every row
 * collapses to a dash and the refresh button is not rendered at all rather
 * than offered and then rejected with 409 by the API.
 *
 * @param playerId Panel player id used to build the refresh request.
 * @param steamId64 The player's SteamID64, or `null` for EOS-only accounts.
 * @param snapshot Server-rendered snapshot; refreshing replaces it in place.
 */
export function SteamProfileSection({
  playerId,
  steamId64,
  snapshot,
}: {
  playerId: string;
  steamId64: string | null;
  snapshot: SteamSnapshot;
}) {
  const [current, setCurrent] = useState<SteamSnapshot>(snapshot);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasSteam = steamId64 !== null;
  const playtimeMinutes = current.steam_playtime_minutes;
  const daysSinceLastBan = current.days_since_last_ban;

  async function refresh(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/v1/players/${playerId}/steam-refresh`, {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
      });
      if (!response.ok) {
        setError(refreshErrorMessage(response.status));
        return;
      }
      setCurrent((await response.json()) as SteamSnapshot);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="rounded border border-neutral-800 bg-neutral-950 p-4 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xs uppercase tracking-widest text-neutral-400">Steam</h2>
        {hasSteam && (
          <button
            type="button"
            onClick={refresh}
            disabled={loading}
            className="rounded border border-neutral-700 px-2 py-1 text-xs text-sky-400 hover:text-sky-300 disabled:opacity-50"
          >
            {loading ? 'Обновление…' : 'Обновить из Steam'}
          </button>
        )}
      </div>
      {error && <p className="text-xs text-red-300">{error}</p>}
      <dl className="grid grid-cols-[160px_1fr] gap-y-1 text-sm">
        <dt className="text-neutral-500">Ник в Steam</dt>
        <dd data-testid="steam-persona">{current.persona_name ?? DASH}</dd>
        <dt className="text-neutral-500">VAC-бан</dt>
        <dd data-testid="steam-vac">
          {!hasSteam ? DASH : current.vac_banned ? `Да (${current.vac_ban_count ?? 0})` : 'Нет'}
        </dd>
        <dt className="text-neutral-500">Game-баны</dt>
        <dd data-testid="steam-game-bans">{hasSteam ? (current.game_ban_count ?? 0) : DASH}</dd>
        <dt className="text-neutral-500">Дней с последнего бана</dt>
        <dd data-testid="steam-days-since-ban">
          {hasSteam && daysSinceLastBan != null ? daysSinceLastBan : DASH}
        </dd>
        <dt className="text-neutral-500">Владеет Squad</dt>
        <dd data-testid="steam-owns-squad">
          {hasSteam ? ownershipLabel(current.owns_squad) : DASH}
        </dd>
        <dt className="text-neutral-500">Наиграно в Squad</dt>
        <dd data-testid="steam-playtime">
          {hasSteam && playtimeMinutes != null ? `${Math.round(playtimeMinutes / 60)} ч` : DASH}
        </dd>
        <dt className="text-neutral-500">Проверено</dt>
        <dd data-testid="steam-checked-at">
          {current.steam_checked_at
            ? new Date(current.steam_checked_at).toLocaleString()
            : 'не проверялся'}
        </dd>
      </dl>
    </section>
  );
}
