'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import {
  banStatusBadge,
  buildApiQuery,
  buildQueryString,
  formatDate,
  identityLabel,
  parseFilters,
  trustLevelBadgeClass,
  trustLevelLabel,
} from './helpers';

interface RegistryBan {
  id: string;
  source_id: string;
  source_name: string;
  trust_level: string;
  discord_url: string | null;
  nickname: string | null;
  reason: string | null;
  admin_name: string | null;
  issued_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  is_active: boolean;
  is_permanent: boolean;
}

interface RegistryRow {
  steam_id64: string | null;
  eos_id: string | null;
  player_id: string | null;
  panel_nickname: string | null;
  bans: RegistryBan[];
  active_source_count: number;
}

interface RegistryResponse {
  rows: RegistryRow[];
  total: number;
  limit: number;
  offset: number;
}

interface BanSourceOption {
  id: string;
  name: string;
}

export function ExternalBansBrowser() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const filters = parseFilters(searchParams);

  const [qInput, setQInput] = useState(filters.q);
  const [rows, setRows] = useState<RegistryRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sources, setSources] = useState<BanSourceOption[]>([]);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  useEffect(() => {
    setQInput(filters.q);
    // Only re-sync the input when navigation changes q externally (e.g. back button).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.q]);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/v1/ban-sources', { credentials: 'include', cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : []))
      .then((body: BanSourceOption[]) => {
        if (!cancelled) setSources(body);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const navigate = useCallback(
    (partial: Partial<typeof filters>) => {
      const next = { ...filters, ...partial };
      if (
        partial.q !== undefined ||
        partial.permanentOnly !== undefined ||
        partial.sourceId !== undefined
      ) {
        next.offset = 0;
      }
      const qs = buildQueryString(next);
      router.replace(qs ? `${pathname}?${qs}` : pathname);
    },
    [filters, pathname, router],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/external-bans?${buildApiQuery(filters)}`, {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as RegistryResponse;
      setRows(data.rows);
      setTotal(data.total);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    void load();
  }, [load]);

  function submitSearch(e: React.FormEvent) {
    e.preventDefault();
    navigate({ q: qInput.trim() });
  }

  const hasPrev = filters.offset > 0;
  const hasNext = filters.offset + filters.limit < total;

  return (
    <div className="space-y-6 max-w-4xl">
      <h1 className="text-2xl font-semibold">Внешние баны</h1>
      <p className="text-sm text-neutral-400">
        Агрегированный реестр банов из подключённых внешних источников (CBAN-3).
      </p>

      {error ? (
        <div className="rounded border border-red-900 bg-red-950 p-3 text-sm text-red-200">
          Ошибка: {error}
        </div>
      ) : null}

      <form onSubmit={submitSearch} className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={qInput}
          onChange={(e) => setQInput(e.target.value)}
          placeholder="Ник, SteamID64, EOS ID или причина"
          className="w-72 rounded border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-sm focus:border-neutral-600 focus:outline-none"
        />
        <button
          type="submit"
          className="rounded border border-neutral-800 px-3 py-1.5 text-sm hover:border-neutral-600"
        >
          Искать
        </button>
        <label className="flex items-center gap-1.5 text-sm text-neutral-300">
          <input
            type="checkbox"
            checked={filters.permanentOnly}
            onChange={(e) => navigate({ permanentOnly: e.target.checked })}
          />
          Только перманентные
        </label>
        <select
          value={filters.sourceId}
          onChange={(e) => navigate({ sourceId: e.target.value })}
          className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-200 focus:border-neutral-600 focus:outline-none"
        >
          <option value="">Все источники</option>
          {sources.map((source) => (
            <option key={source.id} value={source.id}>
              {source.name}
            </option>
          ))}
        </select>
      </form>

      {loading ? (
        <div className="py-8 text-center text-sm text-neutral-500">Загрузка…</div>
      ) : rows.length === 0 ? (
        <div className="rounded border border-dashed border-neutral-800 py-12 text-center text-sm text-neutral-500">
          Ничего не найдено.
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((row) => {
            const key = `${row.steam_id64 ?? ''}:${row.eos_id ?? ''}`;
            const expanded = expandedKey === key;
            return (
              <div
                key={key}
                className="rounded border border-neutral-800 bg-neutral-950 p-4 space-y-2"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    {row.player_id ? (
                      <Link
                        href={`/players/${row.player_id}`}
                        className="font-medium text-sky-400 hover:text-sky-300"
                      >
                        {identityLabel(row)}
                      </Link>
                    ) : (
                      <span className="font-medium text-neutral-300">{identityLabel(row)}</span>
                    )}
                    {row.active_source_count > 0 ? (
                      <span className="rounded border border-red-900 bg-red-950/50 px-1.5 py-0.5 text-xs text-red-300">
                        Активен в {row.active_source_count}
                      </span>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2 text-xs text-neutral-500">
                    {row.steam_id64 ? <span className="font-mono">{row.steam_id64}</span> : null}
                    {row.eos_id ? <span className="font-mono">{row.eos_id}</span> : null}
                    <button
                      type="button"
                      onClick={() => setExpandedKey(expanded ? null : key)}
                      className="rounded border border-neutral-800 px-2 py-0.5 hover:border-neutral-600"
                    >
                      {expanded ? 'Скрыть' : `Показать (${row.bans.length})`}
                    </button>
                  </div>
                </div>

                {expanded ? (
                  <ul className="space-y-1">
                    {row.bans.map((ban) => {
                      const status = banStatusBadge(ban);
                      return (
                        <li key={ban.id} className="rounded bg-neutral-900/40 p-2 text-xs">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex items-center gap-1.5">
                              <span className="text-neutral-300">{ban.source_name}</span>
                              <span
                                className={`rounded px-1.5 py-0.5 ${trustLevelBadgeClass(ban.trust_level)}`}
                              >
                                {trustLevelLabel(ban.trust_level)}
                              </span>
                              <span className={`rounded px-1.5 py-0.5 ${status.className}`}>
                                {status.label}
                              </span>
                            </div>
                            <span className="text-neutral-500">
                              {formatDate(ban.issued_at)}
                              {ban.expires_at ? ` → ${formatDate(ban.expires_at)}` : ''}
                            </span>
                          </div>
                          {ban.reason ? (
                            <p className="mt-1 text-neutral-300">{ban.reason}</p>
                          ) : null}
                          {ban.admin_name ? (
                            <p className="mt-0.5 text-neutral-500">Админ: {ban.admin_name}</p>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      {!loading && rows.length > 0 ? (
        <div className="flex items-center justify-between text-xs text-neutral-400">
          <span>
            {filters.offset + 1}–{filters.offset + rows.length} из {total}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={!hasPrev}
              onClick={() => navigate({ offset: Math.max(0, filters.offset - filters.limit) })}
              className="rounded border border-neutral-800 px-3 py-1 hover:border-neutral-600 disabled:opacity-40"
            >
              Назад
            </button>
            <button
              type="button"
              disabled={!hasNext}
              onClick={() => navigate({ offset: filters.offset + filters.limit })}
              className="rounded border border-neutral-800 px-3 py-1 hover:border-neutral-600 disabled:opacity-40"
            >
              Вперёд
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
