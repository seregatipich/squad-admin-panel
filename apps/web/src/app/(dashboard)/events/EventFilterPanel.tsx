'use client';
import { Button, Card, Checkbox, Select } from '@/components/ui';
import { DATE_PRESETS, type EventFilters, type ServerOption } from './helpers';

/**
 * Filter controls of the events journal: event kinds, period, order and, unless the journal is
 * locked to one server, the servers.
 *
 * @param kinds Kind options derived from the loaded events.
 * @param lockedServerId Server the journal is locked to; hides the server selection.
 * @param onChange Called with the changed part of the filters.
 */
export function FilterPanel({
  filters,
  servers,
  kinds,
  lockedServerId,
  onChange,
}: {
  filters: EventFilters;
  servers: ServerOption[];
  kinds: Array<{ value: string; label: string }>;
  lockedServerId: string | undefined;
  onChange: (partial: Partial<EventFilters>) => void;
}) {
  function toggleKind(value: string) {
    const active = filters.kinds.includes(value);
    const nextKinds = active
      ? filters.kinds.filter((entry) => entry !== value)
      : [...filters.kinds, value];
    onChange({ kinds: nextKinds });
  }

  function toggleServer(id: string) {
    const active = filters.servers.includes(id);
    const nextServers = active
      ? filters.servers.filter((entry) => entry !== id)
      : [...filters.servers, id];
    onChange({ servers: nextServers });
  }

  return (
    <Card className="space-y-4">
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-ink-2">Тип события</span>
          {filters.kinds.length > 0 ? (
            <Button variant="plain" size="sm" onClick={() => onChange({ kinds: [] })}>
              Сбросить
            </Button>
          ) : null}
        </div>
        <div className="max-h-56 space-y-1 overflow-y-auto rounded-ctl border border-line p-1">
          {kinds.map((option) => (
            <Checkbox
              key={option.value}
              label={<span className="truncate">{option.label}</span>}
              checked={filters.kinds.includes(option.value)}
              onChange={() => toggleKind(option.value)}
              className="px-1.5"
            />
          ))}
        </div>
      </div>

      <div className="space-y-1.5">
        <span className="block text-xs font-medium text-ink-2">Период</span>
        <Select
          aria-label="Период"
          value={filters.preset}
          onChange={(event) => onChange({ preset: event.target.value as EventFilters['preset'] })}
        >
          {DATE_PRESETS.map((preset) => (
            <option key={preset.value} value={preset.value}>
              {preset.label}
            </option>
          ))}
        </Select>
        {filters.preset === 'custom' ? (
          <div className="flex flex-col gap-2 pt-1">
            <label className="flex items-center justify-between gap-2 text-xs text-ink-3">
              С
              <input
                type="date"
                value={filters.from}
                onChange={(event) => onChange({ from: event.target.value })}
                className="h-8 rounded-ctl border border-line bg-raised px-2 text-xs text-ink"
              />
            </label>
            <label className="flex items-center justify-between gap-2 text-xs text-ink-3">
              По
              <input
                type="date"
                value={filters.to}
                onChange={(event) => onChange({ to: event.target.value })}
                className="h-8 rounded-ctl border border-line bg-raised px-2 text-xs text-ink"
              />
            </label>
          </div>
        ) : null}
      </div>

      <div className="space-y-1.5">
        <span className="block text-xs font-medium text-ink-2">Порядок</span>
        <Select
          aria-label="Порядок событий"
          value={filters.order}
          onChange={(event) => onChange({ order: event.target.value as EventFilters['order'] })}
        >
          <option value="desc">Сначала новые</option>
          <option value="asc">Сначала старые</option>
        </Select>
      </div>

      {lockedServerId ? null : (
        <div className="space-y-1.5">
          <span className="block text-xs font-medium text-ink-2">Серверы</span>
          {servers.length === 0 ? (
            <p className="text-xs text-ink-3">Нет доступных серверов</p>
          ) : (
            <div className="max-h-48 space-y-1 overflow-y-auto rounded-ctl border border-line p-1">
              {servers.map((server) => (
                <Checkbox
                  key={server.id}
                  label={
                    <span className="truncate">
                      {server.display_name ?? server.slug ?? server.id.slice(0, 8)}
                    </span>
                  }
                  checked={filters.servers.includes(server.id)}
                  onChange={() => toggleServer(server.id)}
                  className="px-1.5"
                />
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
