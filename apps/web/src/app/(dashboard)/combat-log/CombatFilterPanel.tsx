'use client';
import { useEffect, useId, useState } from 'react';
import { Button, Checkbox, FieldRow, Select, TextInput } from '@/components/ui';
import { apiFetch, nullOnHttpError } from '@/lib/api';
import { type CombatFilters, DATE_PRESETS, hasActiveFilters } from './helpers';

/** A server offered in the server filter. */
export interface ServerOption {
  id: string;
  display_name: string | null;
  slug: string | null;
}

interface PlayersResponse {
  items: Array<{ id: string; canonical_name: string | null }>;
}

/** Filter controls of the combat log: players, weapon, server, period and the damage and team-kill switches. */
export function FilterPanel({
  filters,
  servers,
  lockedServerId,
  onChange,
  onReset,
}: {
  filters: CombatFilters;
  servers: ServerOption[];
  lockedServerId: string | undefined;
  onChange: (partial: Partial<CombatFilters>) => void;
  onReset: () => void;
}) {
  return (
    <div className="space-y-4">
      <PlayerAutocomplete
        label="Кто"
        placeholder="Ник атакующего"
        value={filters.attackerQuery}
        onCommit={(value) => onChange({ attackerQuery: value, attackerPlayerId: '' })}
      />
      <PlayerAutocomplete
        label="Кого"
        placeholder="Ник цели"
        value={filters.victimQuery}
        onCommit={(value) => onChange({ victimQuery: value, victimPlayerId: '' })}
      />
      <WeaponInput value={filters.weapon} onCommit={(value) => onChange({ weapon: value })} />

      <FieldRow label="Период">
        <Select
          value={filters.preset}
          onChange={(event) => onChange({ preset: event.target.value as CombatFilters['preset'] })}
        >
          {DATE_PRESETS.map((preset) => (
            <option key={preset.value} value={preset.value}>
              {preset.label}
            </option>
          ))}
        </Select>
      </FieldRow>

      {filters.preset === 'custom' ? (
        <div className="flex flex-col gap-2">
          <FieldRow label="С">
            <TextInput
              type="date"
              value={filters.from}
              onChange={(event) => onChange({ from: event.target.value })}
            />
          </FieldRow>
          <FieldRow label="По">
            <TextInput
              type="date"
              value={filters.to}
              onChange={(event) => onChange({ to: event.target.value })}
            />
          </FieldRow>
        </div>
      ) : null}

      {lockedServerId ? null : (
        <div className="space-y-2">
          <p className="text-xs font-medium text-ink-2">Серверы</p>
          {servers.length === 0 ? (
            <p className="text-xs text-ink-3">Нет доступных серверов</p>
          ) : (
            <div className="max-h-48 space-y-1 overflow-y-auto rounded-ctl border border-line p-2">
              {servers.map((server) => {
                const active = filters.serverIds.includes(server.id);
                return (
                  <Checkbox
                    key={server.id}
                    label={server.display_name ?? server.slug ?? server.id.slice(0, 8)}
                    checked={active}
                    onChange={() =>
                      onChange({
                        serverIds: active
                          ? filters.serverIds.filter((id) => id !== server.id)
                          : [...filters.serverIds, server.id],
                      })
                    }
                  />
                );
              })}
            </div>
          )}
        </div>
      )}

      {hasActiveFilters(filters) ? (
        <Button variant="plain" size="sm" onClick={onReset}>
          Сбросить фильтры
        </Button>
      ) : null}
    </div>
  );
}

function PlayerAutocomplete({
  label,
  placeholder,
  value,
  onCommit,
}: {
  label: string;
  placeholder: string;
  value: string;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const listId = useId();

  useEffect(() => {
    setDraft(value);
  }, [value]);

  useEffect(() => {
    const query = draft.trim();
    if (query.length < 2) {
      setSuggestions([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      apiFetch<PlayersResponse | null>(`/api/v1/players?q=${encodeURIComponent(query)}`, {
        signal: controller.signal,
      })
        .catch(nullOnHttpError)
        .then((data) => {
          if (controller.signal.aborted) return;
          const names = (data?.items ?? [])
            .map((item) => item.canonical_name)
            .filter((name): name is string => Boolean(name));
          setSuggestions(Array.from(new Set(names)).slice(0, 10));
        })
        .catch(() => {});
    }, 250);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [draft]);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onCommit(draft.trim());
      }}
    >
      <FieldRow label={label}>
        <TextInput
          type="search"
          list={listId}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            // Only commit when the draft actually changed. A deep link sets
            // attackerPlayerId/victimPlayerId with an empty query — a blur
            // with nothing typed (e.g. Tab past the field) must not fire
            // onCommit and silently clear that id-based filter (#530).
            const trimmed = draft.trim();
            if (trimmed !== value) onCommit(trimmed);
          }}
          placeholder={placeholder}
        />
      </FieldRow>
      <datalist id={listId}>
        {suggestions.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
    </form>
  );
}

function WeaponInput({ value, onCommit }: { value: string; onCommit: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    setDraft(value);
  }, [value]);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onCommit(draft.trim());
      }}
    >
      <FieldRow label="Оружие">
        <TextInput
          type="search"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => onCommit(draft.trim())}
          placeholder="Напр. AK74"
        />
      </FieldRow>
    </form>
  );
}
