'use client';
import { useEffect, useId, useState } from 'react';
import { Button, EmptyState, Modal, SearchField, Select, Skeleton } from '@/components/ui';
import { apiFetch } from '@/lib/api';
import { SEARCH_MIN_CHARS, type SearchCandidate } from './roster-model';

/**
 * Dialog to add a player to the clan: searches players by name, SteamID64 or
 * EOS ID and offers the role the new member gets.
 */
export function AddMemberModal({
  open,
  onClose,
  onAdd,
  allowDeputy,
}: {
  open: boolean;
  onClose: () => void;
  onAdd: (playerId: string, role: string) => void;
  allowDeputy: boolean;
}) {
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<SearchCandidate[]>([]);
  const [searching, setSearching] = useState(false);
  const [role, setRole] = useState('member');
  const addRoleId = useId();

  // SearchField already debounces onCommit (see its own `delay` prop); a
  // second timer here only doubled the wait before a request and added a
  // second place for a stale response to race a newer one. The effect runs
  // straight off the committed `term`, with a `cancelled` guard so an older
  // request never overwrites a newer one's results.
  useEffect(() => {
    const trimmed = term.trim();
    if (trimmed.length < SEARCH_MIN_CHARS) {
      setResults([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    void (async () => {
      try {
        const body = await apiFetch<{ items: SearchCandidate[] }>(
          `/api/v1/players/search?q=${encodeURIComponent(trimmed)}`,
        );
        if (!cancelled) setResults(body.items);
      } catch {
        /* ignore */
      } finally {
        if (!cancelled) setSearching(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [term]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Добавить участника"
      closeLabel="Закрыть"
      footer={
        <Button variant="secondary" onClick={onClose}>
          Отмена
        </Button>
      }
    >
      <div className="space-y-3">
        <SearchField
          value={term}
          onCommit={setTerm}
          label="Поиск игрока"
          placeholder="Ник, SteamID64 или EOS ID (мин. 3 символа)"
          clearLabel="Очистить поиск"
        />

        <div className="flex items-center gap-2 text-xs text-ink-2">
          <label htmlFor={addRoleId}>Роль при добавлении</label>
          <Select
            id={addRoleId}
            size="sm"
            value={role}
            onChange={(e) => setRole(e.target.value)}
            className="w-auto"
          >
            <option value="member">Участник</option>
            {allowDeputy ? <option value="deputy">Зам</option> : null}
          </Select>
        </div>

        <div className="max-h-72 space-y-1 overflow-y-auto">
          {searching ? <Skeleton variant="block" count={2} label="Ищем игроков" /> : null}
          {!searching && term.trim().length >= SEARCH_MIN_CHARS && results.length === 0 ? (
            <EmptyState
              variant="filtered"
              title="Ничего не нашлось"
              description="Ни один игрок не подходит под запрос."
            />
          ) : null}
          {results.map((candidate) => {
            const alreadyInClan = candidate.clan_id !== null;
            return (
              <div
                key={candidate.id}
                className="flex items-center justify-between gap-2 rounded-ctl border border-line bg-raised px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="truncate text-[13px] text-ink">{candidate.canonical_name}</div>
                  <div className="truncate text-xs text-ink-3">
                    {candidate.steam_id64 ?? candidate.eos_id ?? '—'}
                    {alreadyInClan ? (
                      <span className="ml-2 text-warn">
                        уже в клане{candidate.clan_name ? ` «${candidate.clan_name}»` : ''}
                      </span>
                    ) : null}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={alreadyInClan}
                  onClick={() => onAdd(candidate.id, role)}
                >
                  Добавить
                </Button>
              </div>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}
