'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  buildCombatLogTeamkillHref,
  buildTeamkillQueryString,
  buildTeamkillSummaryApiQuery,
  formatModerationSummary,
  formatTeamkillCount,
  formatTeamkillDate,
  parseTeamkillFilters,
  type TeamkillFilters,
  type TeamkillSort,
  type TeamkillSummaryResponse,
  type TeamkillSummaryRow,
  teamkillSortLabel,
} from './helpers';

interface ServerOption {
  id: string;
  display_name: string | null;
  slug: string | null;
}

interface ServersResponse {
  items: ServerOption[];
}

const inputClass =
  'rounded border border-neutral-800 bg-neutral-950 px-3 py-1.5 text-sm text-neutral-100 focus:border-neutral-600 focus:outline-none';

export function TeamkillsBrowser() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const filters = useMemo(() => parseTeamkillFilters(searchParams), [searchParams]);

  const [servers, setServers] = useState<ServerOption[]>([]);
  const [data, setData] = useState<TeamkillSummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const navigate = useCallback(
    (partial: Partial<TeamkillFilters>) => {
      const next: TeamkillFilters = { ...filters, ...partial };
      const qs = buildTeamkillQueryString(next);
      router.replace(qs ? `${pathname}?${qs}` : pathname);
    },
    [filters, pathname, router],
  );

  useEffect(() => {
    let cancelled = false;
    fetch('/api/v1/servers', { credentials: 'include', cache: 'no-store' })
      .then(async (res) => (res.ok ? ((await res.json()) as ServersResponse) : { items: [] }))
      .then((body) => {
        if (!cancelled) setServers(body.items ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/v1/moderation/teamkills?${buildTeamkillSummaryApiQuery(filters)}`, {
      credentials: 'include',
      cache: 'no-store',
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as TeamkillSummaryResponse;
      })
      .then((body) => {
        if (!cancelled) setData(body);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setData(null);
          setError((err as Error).message);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [filters]);

  const rows = data?.rows ?? [];

  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
      <FilterRail filters={filters} servers={servers} onChange={navigate} />

      <main className="min-w-0 flex-1 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">Тимкиллы</h1>
            <p className="mt-1 text-xs text-neutral-500">
              Обновлено: {formatTeamkillDate(data?.generated_at ?? null)}
            </p>
          </div>
          <Link
            href="/combat-log?facet=teamkills"
            className="rounded border border-neutral-800 px-3 py-1.5 text-sm text-neutral-200 no-underline hover:border-neutral-600"
          >
            Боевой лог
          </Link>
        </div>

        {error ? (
          <div className="rounded border border-red-900 bg-red-950 p-3 text-sm text-red-200">
            Ошибка загрузки тимкиллов: {error}
          </div>
        ) : null}

        <TeamkillTable
          rows={rows}
          loading={loading}
          filters={filters}
          onSort={(sort) => {
            const order = filters.sort === sort && filters.order === 'desc' ? 'asc' : 'desc';
            navigate({ sort, order });
          }}
        />
      </main>
    </div>
  );
}

function FilterRail({
  filters,
  servers,
  onChange,
}: {
  filters: TeamkillFilters;
  servers: ServerOption[];
  onChange: (partial: Partial<TeamkillFilters>) => void;
}) {
  return (
    <aside className="w-full shrink-0 space-y-5 rounded border border-neutral-800 bg-neutral-950/40 p-4 lg:sticky lg:top-4 lg:w-72">
      <div className="space-y-1.5">
        <span className="text-xs uppercase tracking-widest text-neutral-500">Сервер</span>
        <select
          value={filters.serverId}
          onChange={(event) => onChange({ serverId: event.target.value })}
          className={`w-full ${inputClass}`}
        >
          <option value="all">Все серверы</option>
          {servers.map((server) => (
            <option key={server.id} value={server.id}>
              {server.display_name ?? server.slug ?? server.id.slice(0, 8)}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-1.5">
        <span className="text-xs uppercase tracking-widest text-neutral-500">Сортировка</span>
        <div className="grid grid-cols-3 overflow-hidden rounded border border-neutral-800">
          {(['tk_7d', 'tk_30d', 'total'] as const).map((sort) => (
            <button
              key={sort}
              type="button"
              onClick={() => onChange({ sort })}
              aria-pressed={filters.sort === sort}
              className={`px-2 py-1.5 text-xs ${
                filters.sort === sort
                  ? 'bg-neutral-800 text-neutral-50'
                  : 'text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200'
              }`}
            >
              {teamkillSortLabel(sort)}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-1.5">
        <span className="text-xs uppercase tracking-widest text-neutral-500">Порядок</span>
        <div className="grid grid-cols-2 overflow-hidden rounded border border-neutral-800">
          <button
            type="button"
            onClick={() => onChange({ order: 'desc' })}
            aria-pressed={filters.order === 'desc'}
            className={`px-2 py-1.5 text-xs ${
              filters.order === 'desc'
                ? 'bg-neutral-800 text-neutral-50'
                : 'text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200'
            }`}
          >
            По убыванию
          </button>
          <button
            type="button"
            onClick={() => onChange({ order: 'asc' })}
            aria-pressed={filters.order === 'asc'}
            className={`px-2 py-1.5 text-xs ${
              filters.order === 'asc'
                ? 'bg-neutral-800 text-neutral-50'
                : 'text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200'
            }`}
          >
            По возрастанию
          </button>
        </div>
      </div>
    </aside>
  );
}

function TeamkillTable({
  rows,
  loading,
  filters,
  onSort,
}: {
  rows: TeamkillSummaryRow[];
  loading: boolean;
  filters: TeamkillFilters;
  onSort: (sort: TeamkillSort) => void;
}) {
  if (loading && rows.length === 0) {
    return <div className="py-12 text-center text-sm text-neutral-500">Загрузка…</div>;
  }
  if (!loading && rows.length === 0) {
    return (
      <div className="rounded border border-dashed border-neutral-800 py-12 text-center text-sm text-neutral-400">
        Тимкиллы не найдены.
      </div>
    );
  }

  return (
    <>
      <div className="hidden overflow-x-auto rounded border border-neutral-800 bg-neutral-950 md:block">
        <table className="w-full min-w-[820px] text-sm">
          <thead className="text-left text-xs uppercase text-neutral-500">
            <tr>
              <th className="px-3 py-2 font-medium">Игрок</th>
              <SortableHead sort="tk_7d" filters={filters} onSort={onSort} />
              <SortableHead sort="tk_30d" filters={filters} onSort={onSort} />
              <SortableHead sort="total" filters={filters} onSort={onSort} />
              <th className="px-3 py-2 text-right font-medium">Получал TK</th>
              <th className="px-3 py-2 font-medium">Последний TK</th>
              <th className="px-3 py-2 font-medium">Модерация</th>
              <th className="px-3 py-2 font-medium">Переходы</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.player_id}
                className="border-t border-neutral-900 hover:bg-neutral-900/40"
              >
                <td className="px-3 py-2">
                  <Link
                    href={`/all-players/${row.player_id}`}
                    className="font-medium text-sky-300 no-underline hover:text-sky-200"
                  >
                    {row.current_name ?? row.player_id.slice(0, 8)}
                  </Link>
                  <div className="font-mono text-[11px] text-neutral-600">
                    {row.steam_id64 ?? row.eos_id ?? row.player_id}
                  </div>
                </td>
                <NumericCell value={row.tk_7d} />
                <NumericCell value={row.tk_30d} />
                <NumericCell value={row.tk_total} />
                <NumericCell value={row.victim_of_tk_total} muted />
                <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-neutral-400">
                  {formatTeamkillDate(row.last_tk_at)}
                </td>
                <td
                  className={`whitespace-nowrap px-3 py-2 text-xs ${
                    row.moderation_total > 0 ? 'text-amber-200' : 'text-neutral-400'
                  }`}
                >
                  {formatModerationSummary(row)}
                </td>
                <td className="px-3 py-2">
                  <Link
                    href={buildCombatLogTeamkillHref({
                      role: 'attacker',
                      playerId: row.player_id,
                    })}
                    className="text-xs text-sky-400 no-underline hover:text-sky-300"
                  >
                    Боевой лог
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="space-y-2 md:hidden">
        {rows.map((row) => (
          <li key={row.player_id} className="rounded border border-neutral-800 bg-neutral-950 p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <Link
                  href={`/all-players/${row.player_id}`}
                  className="font-medium text-sky-300 no-underline hover:text-sky-200"
                >
                  {row.current_name ?? row.player_id.slice(0, 8)}
                </Link>
                <div className="font-mono text-[11px] text-neutral-600">
                  {row.steam_id64 ?? row.eos_id ?? row.player_id}
                </div>
              </div>
              <Link
                href={buildCombatLogTeamkillHref({ role: 'attacker', playerId: row.player_id })}
                className="shrink-0 text-xs text-sky-400 no-underline hover:text-sky-300"
              >
                Лог
              </Link>
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
              <Metric label="7 дней" value={row.tk_7d} />
              <Metric label="30 дней" value={row.tk_30d} />
              <Metric label="Всего" value={row.tk_total} />
              <Metric label="Получал TK" value={row.victim_of_tk_total} muted />
            </dl>
            <div className="mt-2 text-xs text-neutral-500">
              Последний TK: {formatTeamkillDate(row.last_tk_at)}
            </div>
            <div
              className={`mt-1 text-xs ${
                row.moderation_total > 0 ? 'text-amber-200' : 'text-neutral-500'
              }`}
            >
              Модерация: {formatModerationSummary(row)}
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

function SortableHead({
  sort,
  filters,
  onSort,
}: {
  sort: TeamkillSort;
  filters: TeamkillFilters;
  onSort: (sort: TeamkillSort) => void;
}) {
  const active = filters.sort === sort;
  return (
    <th className="px-3 py-2 text-right font-medium">
      <button
        type="button"
        onClick={() => onSort(sort)}
        className="inline-flex items-center gap-1 uppercase text-neutral-400 hover:text-neutral-200"
      >
        {teamkillSortLabel(sort)}
        {active ? <span aria-hidden>{filters.order === 'desc' ? '▼' : '▲'}</span> : null}
      </button>
    </th>
  );
}

function NumericCell({ value, muted = false }: { value: number; muted?: boolean }) {
  return (
    <td
      className={`whitespace-nowrap px-3 py-2 text-right font-mono text-sm ${
        muted ? 'text-neutral-400' : 'text-neutral-100'
      }`}
    >
      {formatTeamkillCount(value)}
    </td>
  );
}

function Metric({
  label,
  value,
  muted = false,
}: {
  label: string;
  value: number;
  muted?: boolean;
}) {
  return (
    <div className="rounded border border-neutral-900 bg-neutral-900/50 p-2">
      <dt className="text-[10px] uppercase tracking-widest text-neutral-500">{label}</dt>
      <dd className={`mt-1 font-mono ${muted ? 'text-neutral-400' : 'text-neutral-100'}`}>
        {formatTeamkillCount(value)}
      </dd>
    </div>
  );
}
