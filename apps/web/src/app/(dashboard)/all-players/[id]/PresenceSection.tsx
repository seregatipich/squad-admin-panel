'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  Badge,
  Button,
  Card,
  CardBody,
  CardGrid,
  CardHeader,
  EmptyState,
  InlineBanner,
  SegmentedControl,
  Skeleton,
  StatTile,
  Table,
  TableBody,
  TableHead,
  TableRow,
  Td,
  Th,
} from '@/components/ui';
import { PresenceChart } from './PresenceChart';
import { PrimetimeSection } from './PrimetimeSection';
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
const MODE_ORDER: SessionMode[] = ['online', 'boost', 'queue', 'seed'];

const TABS = [
  { value: 'calendar', label: 'Календарь' },
  { value: 'servers', label: 'По серверам' },
];

export function PresenceSection({ playerId }: { playerId: string }) {
  const [data, setData] = useState<PresenceResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('calendar');

  const load = useCallback(() => {
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

  useEffect(() => load(), [load]);

  const grid = useMemo(() => {
    if (!data) return null;
    return buildWeekGrid(data.sessions, weekStartMsForEndDay(data.week.to), Date.now());
  }, [data]);

  const servers = useMemo(() => (data ? sortServersByOnline(data.by_server) : []), [data]);

  return (
    <Card padding="none" as="section">
      <CardHeader title="Присутствие" />
      <CardBody className="space-y-4">
        <PresenceChart playerId={playerId} />

        <PrimetimeSection playerId={playerId} />

        {error ? (
          <InlineBanner
            tone="crit"
            title="Не удалось загрузить присутствие"
            description={error}
            action={
              <Button size="sm" onClick={() => load()}>
                Повторить
              </Button>
            }
          />
        ) : loading || !data ? (
          <Skeleton variant="card" label="Загрузка присутствия" />
        ) : (
          <>
            <CardGrid cols={2}>
              <StatTile
                label="Буст"
                value={fmtDuration(data.totals.boost_seconds)}
                hint={`${data.totals.boost_seconds.toLocaleString('ru-RU')} сек буст-времени`}
              />
              <StatTile
                label="Бонусы"
                value={fmtDuration(data.bonus.value_seconds)}
                hint={`Формула по умолчанию: ${BONUS_FORMULA_LABEL}`}
              />
            </CardGrid>

            <SegmentedControl
              ariaLabel="Разрез присутствия"
              items={TABS}
              value={tab}
              onChange={(value) => setTab(value as Tab)}
            />

            {tab === 'calendar' ? (
              <CalendarTab grid={grid} weekLabel={`${data.week.from} — ${data.week.to}`} />
            ) : (
              <ServersTab servers={servers} />
            )}
          </>
        )}
      </CardBody>
    </Card>
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
        <span className="text-xs text-ink-3">Неделя (UTC): {weekLabel}</span>
        <div className="flex items-center gap-3">
          {MODE_ORDER.map((mode) => (
            <span key={mode} className="flex items-center gap-1 text-2xs text-ink-2">
              <span
                aria-hidden="true"
                className="inline-block h-2.5 w-2.5 rounded-sm"
                style={{ backgroundColor: MODE_HEX[mode] }}
              />
              {MODE_LABELS[mode]}
            </span>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto">
        <div className="min-w-[720px] text-2xs text-ink-3">
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
              <div className="flex items-center whitespace-nowrap pr-1 text-ink-2">
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
                    className={`h-5 rounded-sm ${background ? '' : 'bg-raised'}`}
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
      <EmptyState
        title="Присутствия по серверам нет"
        description="Нет данных о присутствии на серверах."
      />
    );
  }
  return (
    <Table ariaLabel="Присутствие по серверам">
      <TableHead>
        <TableRow>
          <Th>Сервер</Th>
          <Th align="right">Онлайн</Th>
          <Th align="right">Буст</Th>
          <Th align="right">Очередь</Th>
          <Th align="right">Сессий</Th>
        </TableRow>
      </TableHead>
      <TableBody>
        {servers.map((server) => (
          <TableRow key={server.server_id}>
            <Td>
              <Badge size="sm" title={server.server_name ?? undefined}>
                {serverLabel(server)}
              </Badge>
            </Td>
            <Td numeric>{fmtDuration(server.online_seconds)}</Td>
            <Td numeric>{fmtDuration(server.boost_seconds)}</Td>
            <Td numeric>{fmtDuration(server.queue_seconds)}</Td>
            <Td numeric>{server.session_count.toLocaleString('ru-RU')}</Td>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
