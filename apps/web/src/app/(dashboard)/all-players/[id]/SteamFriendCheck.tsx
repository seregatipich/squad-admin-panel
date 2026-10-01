'use client';

import { useState } from 'react';
import { Button } from '@/components/ui';
import { apiFetch, describeHttpError } from '@/lib/api';
import { isRecord } from '@/lib/json-guards';

const STEAM_FRIEND_CHECK_REASONS = [
  'private_profile',
  'steam_unavailable',
  'no_steam_id',
  'api_key_missing',
] as const;

export type SteamFriendCheckReason = (typeof STEAM_FRIEND_CHECK_REASONS)[number];

export interface SteamFriendCheckResult {
  in_friend: boolean | null;
  reason: SteamFriendCheckReason | null;
  cached: boolean;
}

function isReason(value: unknown): value is SteamFriendCheckReason {
  return (STEAM_FRIEND_CHECK_REASONS as readonly unknown[]).includes(value);
}

/**
 * Validates a decoded `steam-friend-check` body, returning `null` for any
 * shape mismatch so an unexpected answer is reported as an error rather than
 * silently shown as «Проверка недоступна» (#467).
 */
export function parseSteamFriendCheck(json: unknown): SteamFriendCheckResult | null {
  if (!isRecord(json)) return null;
  const { in_friend: inFriend, reason, cached } = json;
  if (inFriend !== null && typeof inFriend !== 'boolean') return null;
  if (reason !== null && !isReason(reason)) return null;
  if (typeof cached !== 'boolean') return null;
  return { in_friend: inFriend, reason, cached };
}

function resultLabel(result: SteamFriendCheckResult): string {
  if (result.in_friend === true) return 'В друзьях';
  if (result.in_friend === false) return 'Не найдено в друзьях';
  if (result.reason === 'private_profile') return 'Профиль скрыт';
  if (result.reason === 'steam_unavailable') return 'Steam не отвечает — повторите позже';
  if (result.reason === 'no_steam_id') return 'Нет Steam ID';
  if (result.reason === 'api_key_missing')
    return 'Недоступно: Steam API не настроен — добавьте API key';
  return 'Проверка недоступна';
}

/**
 * Checks whether two player accounts are Steam friends when the API is
 * configured. A failed check offers «Повторить» and a shown result
 * «Перепроверить», so neither state is final until a reload (#467).
 */
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
      const body = await apiFetch<unknown>(
        `/api/v1/players/${encodeURIComponent(playerId)}/steam-friend-check?other=${encodeURIComponent(otherPlayerId)}`,
      );
      const nextResult = parseSteamFriendCheck(body);
      if (!nextResult) throw new Error('некорректный ответ сервера');
      setResult(nextResult);
      onResult?.(nextResult);
    } catch (err) {
      setResult(null);
      setError(describeHttpError(err));
    } finally {
      setLoading(false);
    }
  }

  if (error) {
    return (
      <span className="inline-flex items-center gap-2">
        <output className="text-xs text-crit">Ошибка Steam: {error}</output>
        <Button size="sm" variant="plain" loading={loading} onClick={() => void checkFriends()}>
          Повторить
        </Button>
      </span>
    );
  }

  if (result) {
    return (
      <span className="inline-flex items-center gap-2">
        <output className="text-xs text-ink-2" title={result.cached ? 'Кэш 24 ч' : undefined}>
          Steam: {resultLabel(result)}
        </output>
        <Button size="sm" variant="plain" loading={loading} onClick={() => void checkFriends()}>
          Перепроверить
        </Button>
      </span>
    );
  }

  return (
    <Button size="sm" loading={loading} onClick={() => void checkFriends()}>
      Проверить друзей
    </Button>
  );
}
