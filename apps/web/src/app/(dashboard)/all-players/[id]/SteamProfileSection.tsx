'use client';

import { useState } from 'react';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  DateTime,
  GroupedRow,
  InlineBanner,
} from '@/components/ui';
import { useIntlLocale } from '@/i18n/LocaleProvider';

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
  const locale = useIntlLocale();
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
    <Card padding="none" as="section">
      <CardHeader
        title="Steam"
        actions={
          hasSteam ? (
            <Button size="sm" loading={loading} onClick={refresh}>
              Обновить из Steam
            </Button>
          ) : undefined
        }
      />
      {error ? (
        <CardBody>
          <InlineBanner tone="crit" title="Не удалось обновить данные Steam" description={error} />
        </CardBody>
      ) : null}
      <div className="divide-y divide-line">
        <GroupedRow
          label="Ник в Steam"
          control={<span data-testid="steam-persona">{current.persona_name ?? DASH}</span>}
        />
        <GroupedRow
          label="VAC-бан"
          control={
            <span data-testid="steam-vac">
              {!hasSteam ? DASH : current.vac_banned ? `Да (${current.vac_ban_count ?? 0})` : 'Нет'}
            </span>
          }
        />
        <GroupedRow
          label="Game-баны"
          control={
            <span data-testid="steam-game-bans">
              {hasSteam ? (current.game_ban_count ?? 0) : DASH}
            </span>
          }
        />
        <GroupedRow
          label="Дней с последнего бана"
          control={
            <span data-testid="steam-days-since-ban">
              {hasSteam && daysSinceLastBan != null ? daysSinceLastBan : DASH}
            </span>
          }
        />
        <GroupedRow
          label="Владеет Squad"
          control={
            <span data-testid="steam-owns-squad">
              {hasSteam ? ownershipLabel(current.owns_squad) : DASH}
            </span>
          }
        />
        <GroupedRow
          label="Наиграно в Squad"
          control={
            <span data-testid="steam-playtime">
              {hasSteam && playtimeMinutes != null ? `${Math.round(playtimeMinutes / 60)} ч` : DASH}
            </span>
          }
        />
        <GroupedRow
          label="Проверено"
          control={
            <span data-testid="steam-checked-at">
              {current.steam_checked_at ? (
                <DateTime value={current.steam_checked_at} locale={locale} />
              ) : (
                'не проверялся'
              )}
            </span>
          }
        />
      </div>
    </Card>
  );
}
