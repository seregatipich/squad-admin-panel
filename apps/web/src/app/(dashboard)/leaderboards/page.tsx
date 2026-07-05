'use client';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

interface LeaderboardRow {
  rank: number;
  player_id: string;
  current_name: string;
  steam_id64: string | null;
  eos_id: string | null;
  metric_value: number;
  secondary: {
    online_seconds: number;
    seeding_seconds: number;
    kills: number;
    deaths: number;
    kd: number;
    matches_played: number;
  };
}

interface LeaderboardBody {
  metric: string;
  period: string;
  period_start: string;
  server_id: string | null;
  available: boolean;
  total_rows: number;
  total_pages: number;
  rows: LeaderboardRow[];
}

interface ServerOption {
  id: string;
  display_name: string;
}

type Metric = 'online' | 'seeding' | 'kills' | 'deaths' | 'kd' | 'revives' | 'teamkills';
type Period = 'day' | 'week' | 'month' | 'alltime';

const METRICS: { value: Metric; label: string }[] = [
  { value: 'online', label: 'Онлайн' },
  { value: 'seeding', label: 'Сидинг' },
  { value: 'kills', label: 'Убийства' },
  { value: 'deaths', label: 'Смерти' },
  { value: 'kd', label: 'K/D' },
  { value: 'revives', label: 'Возрождения' },
  { value: 'teamkills', label: 'Тимкиллы' },
];

const PERIODS: { value: Period; label: string }[] = [
  { value: 'day', label: 'Сегодня' },
  { value: 'week', label: 'Неделя' },
  { value: 'month', label: 'Месяц' },
  { value: 'alltime', label: 'Всё время' },
];

const COMBAT_METRICS = new Set<Metric>(['kills', 'deaths', 'kd', 'revives', 'teamkills']);
const PER_PAGE = 30;
const MEDALS: Record<number, string> = { 1: '🥇', 2: '🥈', 3: '🥉' };
const numberFmt = new Intl.NumberFormat('ru-RU');

function metricLabel(metric: Metric): string {
  return METRICS.find((m) => m.value === metric)?.label ?? metric;
}

function formatDuration(seconds: number): string {
  if (!seconds) return '0м';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours === 0) return `${minutes}м`;
  return `${hours}ч ${minutes}м`;
}

function formatMetricValue(metric: Metric, value: number): string {
  if (metric === 'online' || metric === 'seeding') return formatDuration(value);
  if (metric === 'kd') return value.toFixed(2);
  return numberFmt.format(value);
}

export default function LeaderboardsPage() {
  const [metric, setMetric] = useState<Metric>('online');
  const [period, setPeriod] = useState<Period>('alltime');
  const [serverId, setServerId] = useState<string>('all');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [servers, setServers] = useState<ServerOption[]>([]);
  const [data, setData] = useState<LeaderboardBody | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function loadServers() {
      try {
        const res = await fetch('/api/v1/servers', { credentials: 'include', cache: 'no-store' });
        if (!res.ok) return;
        const body = (await res.json()) as { items: ServerOption[] };
        if (!cancelled) setServers(body.items);
      } catch {
        /* server filter stays at "все" when the list is unavailable */
      }
    }
    void loadServers();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    let cancelled = false;
    async function loadBoard() {
      setLoading(true);
      const params = new URLSearchParams({
        metric,
        period,
        server_id: serverId,
        per_page: String(PER_PAGE),
        page: String(page),
      });
      if (search) params.set('search', search);
      try {
        const res = await fetch(`/api/v1/leaderboards?${params.toString()}`, {
          credentials: 'include',
          cache: 'no-store',
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as LeaderboardBody;
        if (!cancelled) {
          setData(body);
          setError(null);
        }
      } catch (loadError) {
        if (!cancelled) setError((loadError as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void loadBoard();
    return () => {
      cancelled = true;
    };
  }, [metric, period, serverId, search, page]);

  const totalPages = data?.total_pages ?? 1;
  const totalRows = data?.total_rows ?? 0;
  const combatPending = !data?.available && COMBAT_METRICS.has(metric);

  const rows = useMemo(() => data?.rows ?? [], [data]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Лидерборды</h1>
        <div className="text-xs text-neutral-500">Всего: {numberFmt.format(totalRows)}</div>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-neutral-400">
          Метрика
          <select
            value={metric}
            onChange={(e) => {
              setMetric(e.target.value as Metric);
              setPage(1);
            }}
            className="rounded border border-neutral-800 bg-neutral-950 px-3 py-1.5 text-sm text-neutral-100"
          >
            {METRICS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-neutral-400">
          Период
          <select
            value={period}
            onChange={(e) => {
              setPeriod(e.target.value as Period);
              setPage(1);
            }}
            className="rounded border border-neutral-800 bg-neutral-950 px-3 py-1.5 text-sm text-neutral-100"
          >
            {PERIODS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-neutral-400">
          Сервер
          <select
            value={serverId}
            onChange={(e) => {
              setServerId(e.target.value);
              setPage(1);
            }}
            className="rounded border border-neutral-800 bg-neutral-950 px-3 py-1.5 text-sm text-neutral-100"
          >
            <option value="all">Все серверы</option>
            {servers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.display_name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-1 min-w-[240px] flex-col gap-1 text-xs text-neutral-400">
          Поиск
          <input
            type="search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Ник, SteamID64 или EOS ID…"
            className="rounded border border-neutral-800 bg-neutral-950 px-3 py-1.5 text-sm text-neutral-100"
          />
        </label>
      </div>

      {error ? (
        <div className="rounded border border-red-900 bg-red-950 p-3 text-sm">{error}</div>
      ) : null}

      {combatPending ? (
        <div className="rounded border border-amber-900/60 bg-amber-950/30 p-3 text-xs text-amber-300">
          Боевые метрики появятся после включения импортёра статистики (STATS-3). Пока значения
          недоступны.
        </div>
      ) : null}

      {rows.length === 0 ? (
        <div className="rounded border border-neutral-800 bg-neutral-950 p-6 text-center text-sm text-neutral-500">
          {loading ? 'Загрузка…' : 'Нет данных за выбранный период.'}
        </div>
      ) : (
        <div className="overflow-x-auto rounded border border-neutral-800">
          <table className="w-full text-sm">
            <thead className="bg-neutral-950 text-xs uppercase tracking-widest text-neutral-500">
              <tr>
                <th className="p-2 text-right">#</th>
                <th className="p-2 text-left">Игрок</th>
                <th className="p-2 text-right text-sky-300">{metricLabel(metric)}</th>
                <th className="p-2 text-right">Онлайн</th>
                <th className="p-2 text-right">Сидинг</th>
                <th className="p-2 text-right">Убийства</th>
                <th className="p-2 text-right">Смерти</th>
                <th className="p-2 text-right">K/D</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.player_id} className="border-t border-neutral-900">
                  <td className="p-2 text-right font-mono text-xs text-neutral-400">
                    {MEDALS[row.rank] ?? row.rank}
                  </td>
                  <td className="p-2">
                    <Link
                      href={`/players/${row.player_id}`}
                      className="font-medium text-sky-400 hover:text-sky-300"
                    >
                      {row.current_name}
                    </Link>
                  </td>
                  <td className="p-2 text-right font-mono text-sky-200">
                    {data?.available ? formatMetricValue(metric, row.metric_value) : '—'}
                  </td>
                  <td className="p-2 text-right font-mono text-xs text-neutral-300">
                    {formatDuration(row.secondary.online_seconds)}
                  </td>
                  <td className="p-2 text-right font-mono text-xs text-neutral-300">
                    {formatDuration(row.secondary.seeding_seconds)}
                  </td>
                  <td className="p-2 text-right font-mono text-xs text-neutral-500">—</td>
                  <td className="p-2 text-right font-mono text-xs text-neutral-500">—</td>
                  <td className="p-2 text-right font-mono text-xs text-neutral-500">—</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-neutral-400">
        <div>
          Страница {numberFmt.format(page)} из {numberFmt.format(totalPages)} · Всего{' '}
          {numberFmt.format(totalRows)}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1 || loading}
            className="rounded border border-neutral-800 px-3 py-1 disabled:opacity-40"
          >
            Назад
          </button>
          <button
            type="button"
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages || loading}
            className="rounded border border-neutral-800 px-3 py-1 disabled:opacity-40"
          >
            Вперёд
          </button>
        </div>
      </div>
    </div>
  );
}
