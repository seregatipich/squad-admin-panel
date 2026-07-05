'use client';

import { useEffect, useMemo, useState } from 'react';

import { PresenceChart } from './PresenceChart';
import {
  BONUS_FORMULA_LABEL,
  buildWeekGrid,
  cellBackground,
  cellTitle,
  dayRowLabel,
  fmtDuration,
  MODE_HEX,
  MODE_LABELS,
  type PresenceResponse,
  type SessionMode,
  serverLabel,
  sortServersByOnline,
  weekStartMsForEndDay,
} from './presence';

type Tab = 'calendar' | 'servers';

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const MODE_ORDER: SessionMode[] = ['online', 'boost', 'queue'];

export function PresenceSection({ playerId }: { playerId: string }) {
  const [data, setData] = useState<PresenceResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('calendar');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/v1/players/${playerId}/presence`, { credentials: 'include', cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((body: PresenceResponse) => {
        if (!cancelled) setData(body);
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [playerId]);

  const grid = useMemo(() => {
    if (!data) return null;
    return buildWeekGrid(data.sessions, weekStartMsForEndDay(data.week.to), Date.now());
  }, [data]);

  const servers = useMemo(() => (data ? sortServersByOnline(data.by_server) : []), [data]);

  return (
    <section className="rounded border border-neutral-800 bg-neutral-950 p-4 space-y-4">
      <h2 className="text-xs uppercase tracking-widest text-neutral-400">Присутствие</h2>

      <PresenceChart playerId={playerId} />

      {error ? (
        <div className="rounded border border-red-900 bg-red-950 p-2 text-xs text-red-200">
          Ошибка: {error}
        </div>
      ) : loading || !data ? (
        <div className="text-sm text-neutral-500">Загрузка…</div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="rounded border border-neutral-800 bg-neutral-900/40 p-3">
              <div className="flex items-center gap-2 text-xs uppercase tracking-widest text-neutral-500">
                <span
                  className="inline-block h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: MODE_HEX.boost }}
                />
                Буст
              </div>
              <div className="mt-1 font-mono text-2xl text-amber-300">
                {fmtDuration(data.totals.boost_seconds)}
              </div>
              <div className="text-[11px] text-neutral-500 tabular-nums">
                {data.totals.boost_seconds.toLocaleString('ru-RU')} сек · буст-время
              </div>
            </div>

            <div className="rounded border border-neutral-800 bg-neutral-900/40 p-3">
              <div className="text-xs uppercase tracking-widest text-neutral-500">Бонусы</div>
              <div className="mt-1 font-mono text-2xl text-emerald-300">
                {fmtDuration(data.bonus.value_seconds)}
              </div>
              <div className="text-[11px] text-neutral-500">
                формула по умолчанию:{' '}
                <span className="text-neutral-400">{BONUS_FORMULA_LABEL}</span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 border-b border-neutral-900">
            <TabButton active={tab === 'calendar'} onClick={() => setTab('calendar')}>
              Календарь
            </TabButton>
            <TabButton active={tab === 'servers'} onClick={() => setTab('servers')}>
              По серверам
            </TabButton>
          </div>

          {tab === 'calendar' ? (
            <CalendarTab grid={grid} weekLabel={`${data.week.from} — ${data.week.to}`} />
          ) : (
            <ServersTab servers={servers} />
          )}
        </>
      )}
    </section>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`-mb-px border-b-2 px-2 py-1.5 text-xs ${
        active
          ? 'border-sky-500 text-sky-300'
          : 'border-transparent text-neutral-500 hover:text-neutral-300'
      }`}
    >
      {children}
    </button>
  );
}

function CalendarTab({
  grid,
  weekLabel,
}: {
  grid: ReturnType<typeof buildWeekGrid> | null;
  weekLabel: string;
}) {
  if (!grid) return null;
  const gridTemplateColumns = `56px repeat(24, minmax(14px, 1fr))`;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11px] text-neutral-500">Неделя (UTC): {weekLabel}</span>
        <div className="flex items-center gap-3">
          {MODE_ORDER.map((mode) => (
            <span key={mode} className="flex items-center gap-1 text-[11px] text-neutral-400">
              <span
                className="inline-block h-2.5 w-2.5 rounded-sm"
                style={{ backgroundColor: MODE_HEX[mode] }}
              />
              {MODE_LABELS[mode]}
            </span>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto">
        <div className="min-w-[720px] text-[10px] text-neutral-500">
          <div className="grid gap-px" style={{ gridTemplateColumns }}>
            <div />
            {HOURS.map((hour) => (
              <div key={hour} className="text-center tabular-nums">
                {hour % 3 === 0 ? hour : ''}
              </div>
            ))}
          </div>

          {grid.days.map((dayKey, dayIndex) => (
            <div key={dayKey} className="mt-px grid gap-px" style={{ gridTemplateColumns }}>
              <div className="flex items-center pr-1 text-neutral-400 whitespace-nowrap">
                {dayRowLabel(dayKey)}
              </div>
              {HOURS.map((hour) => {
                const cell = grid.cells[dayIndex]?.[hour];
                if (!cell) return <div key={hour} className="h-5" />;
                const background = cellBackground(cell);
                return (
                  <div
                    key={hour}
                    role="img"
                    title={cellTitle(cell, dayKey)}
                    aria-label={cellTitle(cell, dayKey)}
                    className={`h-5 rounded-sm ${background ? '' : 'bg-neutral-900/50'}`}
                    style={background ? { backgroundColor: background } : undefined}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ServersTab({ servers }: { servers: PresenceResponse['by_server'] }) {
  if (servers.length === 0) {
    return (
      <div className="rounded border border-dashed border-neutral-800 p-6 text-center text-sm text-neutral-500">
        Нет данных о присутствии на серверах.
      </div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[520px] text-sm">
        <thead className="text-xs uppercase tracking-widest text-neutral-500">
          <tr>
            <th className="p-1 text-left">Сервер</th>
            <th className="p-1 text-right">Онлайн</th>
            <th className="p-1 text-right">Буст</th>
            <th className="p-1 text-right">Очередь</th>
            <th className="p-1 text-right">Сессий</th>
          </tr>
        </thead>
        <tbody>
          {servers.map((server) => (
            <tr key={server.server_id} className="border-t border-neutral-900">
              <td className="p-1">
                <span
                  title={server.server_name ?? undefined}
                  className="inline-block rounded bg-neutral-800 px-1.5 py-0.5 text-xs text-neutral-200"
                >
                  {serverLabel(server)}
                </span>
              </td>
              <td className="p-1 text-right font-mono text-emerald-300">
                {fmtDuration(server.online_seconds)}
              </td>
              <td className="p-1 text-right font-mono text-amber-300">
                {fmtDuration(server.boost_seconds)}
              </td>
              <td className="p-1 text-right font-mono text-sky-300">
                {fmtDuration(server.queue_seconds)}
              </td>
              <td className="p-1 text-right font-mono text-neutral-300 tabular-nums">
                {server.session_count.toLocaleString('ru-RU')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
