'use client';

import { useState } from 'react';
import { Button } from '@/components/ui';

export type SteamFriendCheckReason = 'private_profile' | 'no_steam_id' | 'api_key_missing';

export interface SteamFriendCheckResult {
  in_friend: boolean | null;
  reason: SteamFriendCheckReason | null;
  cached: boolean;
}

function resultLabel(result: SteamFriendCheckResult): string {
  if (result.in_friend === true) return 'В друзьях';
  if (result.in_friend === false) return 'Не найдено в друзьях';
  if (result.reason === 'private_profile') return 'Профиль скрыт';
  if (result.reason === 'no_steam_id') return 'Нет Steam ID';
  if (result.reason === 'api_key_missing')
    return 'Недоступно: Steam API не настроен — добавьте API key';
  return 'Проверка недоступна';
}

/** Checks whether two player accounts are Steam friends when the API is configured. */
export function SteamFriendCheck({
  playerId,
  otherPlayerId,
  onResult,
}: {
  playerId: string;
  otherPlayerId: string;
  onResult?: (result: SteamFriendCheckResult) => void;
}) {
  const [result, setResult] = useState<SteamFriendCheckResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function checkFriends(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/v1/players/${playerId}/steam-friend-check?other=${encodeURIComponent(otherPlayerId)}`,
        { credentials: 'include', cache: 'no-store' },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const nextResult = (await response.json()) as SteamFriendCheckResult;
      setResult(nextResult);
      onResult?.(nextResult);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  if (error) {
    return <output className="text-xs text-crit">Ошибка Steam: {error}</output>;
  }

  if (result) {
    return (
      <output className="text-xs text-ink-2" title={result.cached ? 'Кэш 24 ч' : undefined}>
        Steam: {resultLabel(result)}
      </output>
    );
  }

  return (
    <Button size="sm" loading={loading} onClick={() => void checkFriends()}>
      Проверить друзей
    </Button>
  );
}
