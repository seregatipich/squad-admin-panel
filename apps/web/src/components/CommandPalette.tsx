'use client';

import { useRouter } from 'next/navigation';
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api';
import {
  filterPageResults,
  filterServerResults,
  isPaletteHotkey,
  PALETTE_OPEN_EVENT,
  type PaletteResult,
  type PlayerSearchResult,
  resultHref,
  resultLabel,
  type ServerResult,
  shouldSearchPlayers,
} from '@/lib/commandPalette';
import { NAV_GROUPS } from '@/lib/nav';

interface PlayerSearchResponse {
  items: PlayerSearchResult[];
}

interface ServersResponse {
  items: ServerResult[];
}

const PLAYER_SEARCH_DEBOUNCE_MS = 250;

interface Section {
  title: string;
  results: PaletteResult[];
}

/**
 * Global Ctrl+K / Cmd+K command palette.
 *
 * Opens over any panel page and lets the user jump straight to a page (from
 * {@link NAV_GROUPS}, gated by `permissions`), a player (debounced search
 * once the query is at least `PLAYER_SEARCH_MIN_LENGTH` characters), or a
 * server (fetched once and filtered client-side).
 */
export function CommandPalette({
  permissions,
  economyEnabled = false,
}: {
  permissions: string[];
  /** ECON-5 (#165): pages with `requiresEconomy` are hidden while false. */
  economyEnabled?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [players, setPlayers] = useState<PlayerSearchResult[]>([]);
  const [servers, setServers] = useState<ServerResult[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  // Global hotkey: Ctrl/Cmd+K toggles the palette from anywhere in the app.
  useEffect(() => {
    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (isPaletteHotkey(event)) {
        event.preventDefault();
        setOpen((prev) => !prev);
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // The top bar's search field opens the same palette. It always opens rather
  // than toggles: a click on a field that is already open reads as "focus it".
  useEffect(() => {
    function handleOpenRequest() {
      setOpen(true);
    }
    window.addEventListener(PALETTE_OPEN_EVENT, handleOpenRequest);
    return () => window.removeEventListener(PALETTE_OPEN_EVENT, handleOpenRequest);
  }, []);

  // Escape closes the palette while it is open, regardless of focus.
  useEffect(() => {
    if (!open) return;
    function handleEscape(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [open]);

  // Reset transient state and load the servers list each time the palette opens.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setSelectedIndex(0);
    setPlayers([]);
    inputRef.current?.focus();
    apiFetch<ServersResponse>('/api/v1/servers')
      .then((data) => setServers(data.items ?? []))
      .catch(() => setServers([]));
  }, [open]);

  // Debounced player search, fired once the query is long enough.
  useEffect(() => {
    if (!open || !shouldSearchPlayers(query)) {
      setPlayers([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      apiFetch<PlayerSearchResponse>(`/api/v1/players/search?q=${encodeURIComponent(query.trim())}`)
        .then((data) => {
          if (!cancelled) setPlayers(data.items ?? []);
        })
        .catch(() => {
          if (!cancelled) setPlayers([]);
        });
    }, PLAYER_SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, query]);

  const sections: Section[] = useMemo(() => {
    const pageResults: PaletteResult[] = filterPageResults(
      NAV_GROUPS,
      permissions,
      query,
      economyEnabled,
    ).map((item) => ({ kind: 'page', ...item }));
    const playerResults: PaletteResult[] = players.map((player) => ({
      kind: 'player',
      ...player,
    }));
    const serverResults: PaletteResult[] = filterServerResults(servers, query).map((server) => ({
      kind: 'server',
      ...server,
    }));
    return [
      { title: 'Страницы', results: pageResults },
      { title: 'Игроки', results: playerResults },
      { title: 'Серверы', results: serverResults },
    ].filter((section) => section.results.length > 0);
  }, [permissions, economyEnabled, query, players, servers]);

  const flatResults = useMemo(() => sections.flatMap((section) => section.results), [sections]);

  function close() {
    setOpen(false);
  }

  function select(result: PaletteResult) {
    router.push(resultHref(result));
    close();
  }

  function handleInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelectedIndex((prev) => Math.min(prev + 1, flatResults.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelectedIndex((prev) => Math.max(prev - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const result = flatResults[selectedIndex];
      if (result) select(result);
    } else if (event.key === 'Escape') {
      close();
    }
  }

  if (!open) return null;

  let rowIndex = -1;
  const activeId = `${listId}-option-${selectedIndex}`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-24 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Командная панель"
      // Закрытие по фону проверяет цель события, а не гасит всплытие изнутри:
      // stopPropagation на панели ломал бы любой обработчик выше по дереву.
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') close();
      }}
    >
      <div className="w-full max-w-lg overflow-hidden rounded-card border border-line-2 bg-surface">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelectedIndex(0);
          }}
          onKeyDown={handleInputKeyDown}
          placeholder="Поиск страниц, игроков, серверов…"
          aria-label="Командная панель: поиск"
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={sections.length > 0 ? activeId : undefined}
          aria-autocomplete="list"
          autoComplete="off"
          className="w-full border-b border-line bg-transparent px-4 py-3 text-[13px] text-ink focus-visible:outline-offset-[-2px]"
        />
        <div
          id={listId}
          role="listbox"
          aria-label="Результаты"
          className="max-h-96 overflow-auto py-2"
        >
          {sections.length === 0 ? (
            <p className="px-4 py-3 text-xs text-ink-3">Ничего не найдено.</p>
          ) : (
            sections.map((section) => (
              <div key={section.title} className="mb-1.5 last:mb-0">
                <p className="px-4 pb-1 pt-2 text-2xs font-semibold uppercase tracking-[0.06em] text-ink-3">
                  {section.title}
                </p>
                {section.results.map((result) => {
                  rowIndex += 1;
                  const active = rowIndex === selectedIndex;
                  return (
                    <button
                      key={`${result.kind}-${result.kind === 'page' ? result.href : result.id}`}
                      id={`${listId}-option-${rowIndex}`}
                      type="button"
                      role="option"
                      aria-selected={active}
                      onClick={() => select(result)}
                      onMouseEnter={() => setSelectedIndex(rowIndex)}
                      className={`block w-full px-4 py-2 text-left text-[13px] transition-colors ${
                        active ? 'bg-accent-dim text-ink' : 'text-ink-2 hover:bg-raised'
                      }`}
                    >
                      {resultLabel(result)}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
