'use client';

import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';

import { Skeleton, TextInput } from '@/components/ui';

export interface PickedPlayer {
  id: string;
  canonical_name: string;
}

interface PlayersResponse {
  items: Array<{ id: string; canonical_name: string }>;
}

/**
 * Поиск игрока с подсказками: поле ввода плюс список найденных.
 *
 * Собран по образцу командной палитры: поле — `combobox`, подсказки —
 * `listbox` с `option`, а активная подсказка объявляется через
 * `aria-activedescendant`. Фокус при этом остаётся в поле, поэтому набор
 * запроса и выбор подсказки стрелками — одно непрерывное действие, а не
 * прыжки табуляцией по списку.
 *
 * Запрос уходит после паузы в наборе и только с двух символов: поиск идёт по
 * нескольким колонкам таблицы игроков, и посимвольная отправка превращает
 * набор ника в очередь заведомо ненужных запросов.
 *
 * @param placeholder Подсказка внутри поля; она же — доступное имя поля.
 * @param disabled Поле недоступно, пока идёт вызывающая его операция.
 * @param onSelect Вызывается с выбранным игроком; поле после этого очищается.
 */
export function PlayerSearchSelect({
  placeholder,
  disabled,
  onSelect,
}: {
  placeholder: string;
  disabled?: boolean;
  onSelect: (player: PickedPlayer) => void;
}) {
  const listId = useId();
  const optionIdPrefix = useId();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PickedPlayer[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
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
          setActiveIndex(0);
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
    setActiveIndex(0);
    setOpen(false);
  }

  const listVisible = open && (loading || results.length > 0);
  const activeOptionId = results.length > 0 ? `${optionIdPrefix}-${activeIndex}` : undefined;

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (!listVisible || results.length === 0) {
      // Escape в непустом поле означает «убрать запрос», а не «закрыть экран»:
      // событие дальше не идёт, иначе диалог со списком закрылся бы вместе с ним.
      if (event.key === 'Escape' && query !== '') {
        event.preventDefault();
        event.stopPropagation();
        setQuery('');
      }
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((prev) => Math.min(prev + 1, results.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((prev) => Math.max(prev - 1, 0));
    } else if (event.key === 'Enter') {
      // preventDefault только когда есть что выбрать: иначе Enter в поле внутри
      // формы перестал бы её отправлять.
      const player = results[activeIndex];
      if (player) {
        event.preventDefault();
        pick(player);
      }
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <TextInput
        type="search"
        value={query}
        disabled={disabled}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => results.length > 0 && setOpen(true)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        aria-label={placeholder}
        role="combobox"
        aria-expanded={listVisible}
        // Пока список не показан, его элемента в документе нет — ссылаться на
        // несуществующий идентификатор нельзя.
        aria-controls={listVisible ? listId : undefined}
        aria-activedescendant={listVisible ? activeOptionId : undefined}
        aria-autocomplete="list"
        autoComplete="off"
      />
      {listVisible ? (
        <div className="absolute z-10 mt-1 max-h-52 w-full overflow-auto rounded-card border border-line bg-surface/95 p-1 backdrop-blur-xl">
          {loading ? (
            <div className="px-1.5 py-1">
              <Skeleton variant="text" count={2} label="Поиск игроков" />
            </div>
          ) : null}
          {/* Список держит только подсказки: заглушка загрузки живёт снаружи,
              иначе в `listbox` попал бы элемент, не являющийся `option`. */}
          <div id={listId} role="listbox" aria-label={placeholder}>
            {results.map((player, index) => (
              <button
                key={player.id}
                id={`${optionIdPrefix}-${index}`}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                onClick={() => pick(player)}
                onMouseEnter={() => setActiveIndex(index)}
                className={`block w-full rounded-ctl px-2 py-1.5 text-left text-xs transition-colors duration-150 ${
                  index === activeIndex ? 'bg-accent-dim text-ink' : 'text-ink-2 hover:bg-raised'
                }`}
              >
                {player.canonical_name}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
