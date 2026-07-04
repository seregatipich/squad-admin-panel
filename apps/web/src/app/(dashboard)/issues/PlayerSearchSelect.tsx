'use client';

import { useEffect, useRef, useState } from 'react';

export interface PickedPlayer {
  id: string;
  canonical_name: string;
}

interface PlayersResponse {
  items: Array<{ id: string; canonical_name: string }>;
}

export function PlayerSearchSelect({
  placeholder,
  disabled,
  onSelect,
}: {
  placeholder: string;
  disabled?: boolean;
  onSelect: (player: PickedPlayer) => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PickedPlayer[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const needle = query.trim();
    if (needle.length < 2) {
      setResults([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/v1/players?q=${encodeURIComponent(needle)}`, {
          credentials: 'include',
          cache: 'no-store',
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as PlayersResponse;
        if (!cancelled) {
          setResults(
            data.items.map((item) => ({ id: item.id, canonical_name: item.canonical_name })),
          );
          setOpen(true);
        }
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  useEffect(() => {
    function onClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  function pick(player: PickedPlayer) {
    onSelect(player);
    setQuery('');
    setResults([]);
    setOpen(false);
  }

  return (
    <div ref={containerRef} className="relative">
      <input
        type="search"
        value={query}
        disabled={disabled}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => results.length > 0 && setOpen(true)}
        placeholder={placeholder}
        className="w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs focus:border-neutral-600 focus:outline-none disabled:opacity-40"
      />
      {open && (loading || results.length > 0) ? (
        <ul className="absolute z-10 mt-1 max-h-52 w-full overflow-auto rounded border border-neutral-800 bg-neutral-950 text-xs shadow-lg">
          {loading ? (
            <li className="px-2 py-1.5 text-neutral-500">Поиск…</li>
          ) : (
            results.map((player) => (
              <li key={player.id}>
                <button
                  type="button"
                  onClick={() => pick(player)}
                  className="block w-full px-2 py-1.5 text-left text-neutral-200 hover:bg-neutral-800"
                >
                  {player.canonical_name}
                </button>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
