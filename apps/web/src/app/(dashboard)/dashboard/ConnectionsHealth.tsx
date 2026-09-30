'use client';
import { HEARTBEAT_INTERVAL_MS, HEARTBEAT_TTL_SECONDS } from '@squad/shared-config/heartbeat';
import {
  Card,
  CardBody,
  CardHeader,
  InlineBanner,
  StatusBadge,
  StatusDot,
  type StatusState,
} from '@/components/ui';
import type { BridgeStatus, ReadyCheck, Worker } from './types';

// Mirrors the heartbeat contract in packages/shared-config/src/heartbeat.ts:
// a key older than 2× the publish interval is "behind" (slow tick, GC
// pause), and it disappears entirely once the TTL elapses — so "crit"
// tracks the TTL, not a value hardcoded independently of it.
const WORKER_OK_MS = 2 * HEARTBEAT_INTERVAL_MS;

const WORKER_STALE_MS = HEARTBEAT_TTL_SECONDS * 1_000;

interface ConnectionRow {
  key: string;
  group: 'core' | 'workers';
  name: string;
  state: StatusState;
  status: string;
  detail?: string;
}

export function buildConnectionRows(
  ready: ReadyCheck | null,
  bridge: BridgeStatus | null,
  workers: Worker[],
  readyError: string | null,
): ConnectionRow[] {
  const rows: ConnectionRow[] = [];

  // `/ready` failing outright (API/Redis outage) is not the same as it
  // answering with a check that reports unhealthy — the first must not read
  // as merely «нет данных» (DASH-545).
  const pgState = ready?.checks.postgres;
  rows.push({
    key: 'postgres',
    group: 'core',
    name: 'PostgreSQL',
    status:
      pgState === 'ok'
        ? 'здоров'
        : pgState
          ? 'недоступен'
          : readyError
            ? 'ошибка проверки'
            : 'нет данных',
    state: pgState === 'ok' ? 'good' : pgState || readyError ? 'crit' : 'idle',
  });

  const redisState = ready?.checks.redis;
  rows.push({
    key: 'redis',
    group: 'core',
    name: 'Redis',
    status:
      redisState === 'ok'
        ? 'здоров'
        : redisState
          ? 'недоступен'
          : readyError
            ? 'ошибка проверки'
            : 'нет данных',
    state: redisState === 'ok' ? 'good' : redisState || readyError ? 'crit' : 'idle',
  });

  rows.push({
    key: 'bridge',
    group: 'core',
    name: 'panel-host-bridge',
    status: bridge?.connected ? 'подключён' : (bridge?.error ?? 'отключён'),
    detail: bridge?.connected
      ? `RTT ${bridge.round_trip_ms ?? '?'} мс${bridge.version ? ` · v${bridge.version}` : ''}`
      : undefined,
    state: bridge?.connected ? 'good' : 'crit',
  });

  const expected = ['rcon', 'log-ingest', 'audit-archiver', 'event-partition'];
  const byName = new Map(workers.map((w) => [w.name, w]));
  // `expected` only names the four best-known workers; ~17 more (scheduler,
  // backup, ban-sync, …) also write a heartbeat and must not be silently
  // dropped just because they aren't in that hardcoded list (DASH-544).
  const extraNames = workers
    .map((w) => w.name)
    .filter((name) => !expected.includes(name))
    .sort((a, b) => a.localeCompare(b));
  for (const name of [...expected, ...extraNames]) {
    const w = byName.get(name);
    if (!w) {
      rows.push({
        key: `worker-${name}`,
        group: 'workers',
        name: `worker-${name}`,
        status: 'нет heartbeat',
        state: 'crit',
      });
      continue;
    }
    const state: StatusState =
      w.age_ms > WORKER_STALE_MS ? 'crit' : w.age_ms > WORKER_OK_MS ? 'warn' : 'good';
    rows.push({
      key: `worker-${name}`,
      group: 'workers',
      name: `worker-${name}`,
      status: w.status ?? 'жив',
      detail: `${Math.round(w.age_ms / 1000)}с назад · pid ${w.pid}`,
      state,
    });
  }

  return rows;
}

export function ConnectionsHealth({
  rows,
  healthyCount,
  totalCount,
  bridgeConnected,
  workersError,
}: {
  rows: ConnectionRow[];
  healthyCount: number;
  totalCount: number;
  bridgeConnected: boolean;
  workersError: string | null;
}) {
  const summaryState: StatusState =
    healthyCount === totalCount ? 'good' : healthyCount > 0 ? 'warn' : 'crit';
  const core = rows.filter((r) => r.group === 'core');
  const workers = rows.filter((r) => r.group === 'workers');

  return (
    <Card as="section" padding="none" className="flex h-full flex-col">
      <CardHeader
        title="Соединения"
        actions={
          <StatusBadge
            state={summaryState}
            label={`${healthyCount} из ${totalCount} здоровы`}
            size="sm"
          />
        }
      />
      <CardBody className="space-y-4">
        <ConnectionGroup label="Базовые службы" rows={core} />
        {workersError ? (
          // Список воркеров не загрузился: без баннера все ожидаемые воркеры
          // молча падают в «нет heartbeat», неотличимо от реального сбоя
          // heartbeat (DASH-545).
          <InlineBanner
            tone="warn"
            title="Не удалось получить список воркеров"
            description={workersError}
          />
        ) : (
          <ConnectionGroup
            label="Воркеры"
            rows={workers}
            footnote={
              bridgeConnected
                ? 'Перезапуск воркеров выполняется через docker compose.'
                : 'Bridge оффлайн — состояние воркеров может быть устаревшим.'
            }
          />
        )}
      </CardBody>
    </Card>
  );
}

function ConnectionGroup({
  label,
  rows,
  footnote,
}: {
  label: string;
  rows: ConnectionRow[];
  footnote?: string;
}) {
  return (
    <section className="space-y-2">
      {/* Смысловой заголовок раздела, поэтому обычный регистр, а не капслок (§1). */}
      <h3 className="text-xs font-semibold text-ink-2">{label}</h3>
      <ul className="divide-y divide-line overflow-hidden rounded-ctl border border-line">
        {rows.map((r) => (
          <li key={r.key} className="flex items-center gap-2 px-2.5 py-2">
            <span className="min-w-0 flex-1 truncate text-xs text-ink">{r.name}</span>
            <StatusDot state={r.state} label={r.status} size="sm" />
            {r.detail ? (
              <span className="shrink-0 whitespace-nowrap text-2xs text-ink-3" title={r.detail}>
                {r.detail}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      {footnote ? <p className="text-2xs text-ink-3">{footnote}</p> : null}
    </section>
  );
}
