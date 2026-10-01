'use client';

import { useEffect, useState } from 'react';
import { Checkbox, FieldRow, Select, TextInput } from '@/components/ui';
import { DATE_PRESETS, type MatchFilters, type ServerOption } from './helpers';

/** Filter form shared by the toolbar drawer and the inline filter column. */
export function MatchFilterPanel({
  filters,
  servers,
  onChange,
}: {
  filters: MatchFilters;
  servers: ServerOption[];
  onChange: (partial: Partial<MatchFilters>) => void;
}) {
  const [layerDraft, setLayerDraft] = useState(filters.layer);
  useEffect(() => {
    setLayerDraft(filters.layer);
  }, [filters.layer]);

  function toggleServer(id: string) {
    const active = filters.servers.includes(id);
    const nextServers = active
      ? filters.servers.filter((entry) => entry !== id)
      : [...filters.servers, id];
    onChange({ servers: nextServers });
  }

  return (
    <div className="space-y-4">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onChange({ layer: layerDraft.trim() });
        }}
      >
        <FieldRow label="Layer">
          <TextInput
            type="search"
            value={layerDraft}
            onChange={(event) => setLayerDraft(event.target.value)}
            onBlur={() => onChange({ layer: layerDraft.trim() })}
            placeholder="Напр. Yehorivka"
          />
        </FieldRow>
      </form>

      <FieldRow label="Период">
        <Select
          value={filters.preset}
          onChange={(event) => onChange({ preset: event.target.value as MatchFilters['preset'] })}
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

      <div className="space-y-2">
        <p className="text-xs font-medium text-ink-2">Серверы</p>
        {servers.length === 0 ? (
          <p className="text-xs text-ink-3">Нет доступных серверов</p>
        ) : (
          <div className="max-h-48 space-y-1 overflow-y-auto rounded-ctl border border-line p-2">
            {servers.map((server) => (
              <Checkbox
                key={server.id}
                label={server.display_name ?? server.slug ?? server.id.slice(0, 8)}
                checked={filters.servers.includes(server.id)}
                onChange={() => toggleServer(server.id)}
              />
            ))}
          </div>
        )}
      </div>

      <Checkbox
        label="Скрывать seeding"
        checked={filters.hideSeeding}
        onChange={(event) => onChange({ hideSeeding: event.target.checked })}
      />
    </div>
  );
}
