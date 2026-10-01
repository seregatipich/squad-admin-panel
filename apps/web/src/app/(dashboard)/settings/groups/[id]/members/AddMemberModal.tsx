'use client';

import { useEffect, useState } from 'react';
import { Button, Modal, TextInput } from '@/components/ui';
import { ApiError, apiFetch } from '@/lib/api';
import { NETWORK_ERROR_TEXT, type PlayerSearchItem } from './members-shared';

/** Bounds of `/api/v1/players/search`'s `q` parameter (server `searchQuery`). */
const PLAYER_SEARCH_MIN_LENGTH = 3;
const PLAYER_SEARCH_MAX_LENGTH = 64;

export function AddMemberModal({
  onClose,
  onAdd,
}: {
  onClose: () => void;
  onAdd: (p: PlayerSearchItem) => void;
}) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<PlayerSearchItem[]>([]);
  const [searchErr, setSearchErr] = useState<string | null>(null);
  const trimmed = q.trim();
  const queryTooShort = trimmed.length < PLAYER_SEARCH_MIN_LENGTH;

  useEffect(() => {
    setSearchErr(null);
    if (queryTooShort) {
      setResults([]);
      return;
    }
    const controller = new AbortController();
    const handler = setTimeout(async () => {
      const url = `/api/v1/players/search?q=${encodeURIComponent(trimmed.slice(0, PLAYER_SEARCH_MAX_LENGTH))}`;
      try {
        const found = await apiFetch<{ items: PlayerSearchItem[] }>(url, {
          signal: controller.signal,
        });
        setResults(found.items);
      } catch (e) {
        if (controller.signal.aborted) return;
        setResults([]);
        setSearchErr(
          `Не удалось выполнить поиск: ${e instanceof ApiError ? e.status : NETWORK_ERROR_TEXT}`,
        );
      }
    }, 250);
    return () => {
      clearTimeout(handler);
      controller.abort();
    };
  }, [trimmed, queryTooShort]);

  return (
    <Modal open onClose={onClose} title="Добавить игрока" closeLabel="Закрыть">
      <div className="space-y-3">
        <TextInput
          type="search"
          placeholder="Ник или SteamID64…"
          aria-label="Поиск игрока"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <ul className="max-h-80 divide-y divide-line overflow-auto">
          {searchErr ? (
            <li className="py-2 text-xs text-crit">{searchErr}</li>
          ) : results.length === 0 ? (
            <li className="py-2 text-xs text-ink-3">
              {queryTooShort
                ? `Введите хотя бы ${PLAYER_SEARCH_MIN_LENGTH} символа для поиска…`
                : 'Игроки не найдены.'}
            </li>
          ) : null}
          {results.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-3 py-2">
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-[13px]">{r.canonical_name}</span>
                <span className="font-mono text-2xs text-ink-3">{r.steam_id64 ?? '—'}</span>
              </div>
              <Button size="sm" variant="primary" onClick={() => onAdd(r)}>
                Назначить
              </Button>
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}
