'use client';
import { useState } from 'react';
import { DockerPruneButton } from '@/components/DockerPruneButton';
import { MetricHistoryModal, type MetricKey } from '@/components/MetricHistoryModal';
import { RestartBridgeButton } from '@/components/RestartBridgeButton';
import {
  Card,
  CardBody,
  CardHeader,
  InlineBanner,
  Skeleton,
  StatTile,
  type StatTileTone,
  StatusBadge,
  StatusDot,
  type StatusState,
} from '@/components/ui';
import { formatBytes, formatBytesPerSec, formatPercent, formatUptime, ratio } from '@/lib/format';
import { type computeHostHealth, type HealthLevel, thresholdTone } from '@/lib/host-health';
import { HEALTH_LABEL } from './shared';
import type { BridgeStatus, DiskBreakdown, HostInfo, HostMetrics } from './types';

const HEALTH_STATE: Record<HealthLevel, StatusState> = {
  healthy: 'good',
  warning: 'warn',
  critical: 'crit',
  unknown: 'idle',
};

/**
 * `thresholdTone` живёт в `lib/host-health` и говорит на языке палитры
 * (`emerald`/`amber`/`red`), а плитка — на языке состояний дизайн-системы.
 * Перевод делается здесь, чтобы не менять общую библиотеку ради одной страницы.
 */
const THRESHOLD_TILE_TONE: Record<ReturnType<typeof thresholdTone>, StatTileTone> = {
  emerald: 'good',
  amber: 'warn',
  red: 'crit',
};

export function HostBlock({
  bridge,
  info,
  infoError,
  metrics,
  metricsError,
  health,
  diskBreakdown,
  onDiskClick,
}: {
  bridge: BridgeStatus | null;
  info: HostInfo | null;
  infoError: string | null;
  metrics: HostMetrics | null;
  metricsError: string | null;
  health: ReturnType<typeof computeHostHealth>;
  diskBreakdown: DiskBreakdown | null;
  onDiskClick: () => void;
}) {
  const [openMetric, setOpenMetric] = useState<MetricKey | null>(null);
  const bridgeConnected = bridge?.connected === true;
  /*
   * `bridge === null` — статус ещё не пришёл, `connected: false` — пришёл и
   * говорит, что метрик не будет. Без этого различия карточка вечно крутила
   * четыре скелетона: агент лежит, данные не придут никогда, а панель делает
   * вид, что вот-вот загрузит.
   */
  const bridgeDown = bridge !== null && !bridgeConnected;
  const noMetrics = info === null || metrics === null;

  return (
    <Card as="section" padding="none" className="flex h-full flex-col">
      <CardHeader
        title="Хост"
        actions={
          <StatusBadge
            state={HEALTH_STATE[health.level]}
            label={HEALTH_LABEL[health.level]}
            size="sm"
          />
        }
      />

      <CardBody className="space-y-1 border-b border-line">
        <p className="truncate text-[13px] font-semibold text-ink">
          {info?.hostname ?? (
            <span className="font-normal text-ink-3">
              {bridgeDown ? 'Хост не опознан' : 'Нет данных'}
            </span>
          )}
        </p>
        <p className="truncate text-xs text-ink-3">
          {info ? (
            <>
              {info.os_name} {info.os_version} · {info.arch} · аптайм{' '}
              {formatUptime(info.uptime_seconds)}
            </>
          ) : bridgeDown ? (
            'Имя, ОС и аптайм читает агент — он не отвечает.'
          ) : infoError ? (
            infoError.includes(' 403') ? (
              'Нет прав на просмотр сведений о хосте.'
            ) : (
              `Не удалось загрузить сведения о хосте: ${infoError}`
            )
          ) : (
            'Загружаем сведения о хосте…'
          )}
        </p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 pt-1 text-xs text-ink-3">
          <StatusDot
            state={bridgeConnected ? 'good' : 'crit'}
            size="sm"
            label={
              bridgeConnected
                ? `Bridge подключён${bridge?.version ? ` (v${bridge.version})` : ''}`
                : 'Bridge недоступен'
            }
          />
          <DockerPruneButton
            disabled={!bridgeConnected}
            disabledReason="Сначала восстановите соединение."
          />
          <RestartBridgeButton
            disabled={!bridgeConnected}
            disabledReason="Сначала восстановите соединение."
          />
        </div>
      </CardBody>

      <CardBody
        className={
          noMetrics && (bridgeDown || metricsError) ? undefined : 'grid gap-4 sm:grid-cols-2'
        }
      >
        {noMetrics ? (
          bridgeDown ? (
            <InlineBanner
              tone="warn"
              title="Метрики хоста недоступны"
              description="Агент panel-host-bridge не отвечает, поэтому CPU, память, диск и сеть панели неоткуда взять. Запустите агент на хосте — плитки заполнятся сами."
            />
          ) : metricsError ? (
            // Без отдельного баннера 403 от отсутствующего host:metrics выглядел
            // как вечная загрузка: bridge подключён, а метрики всё равно не
            // появляются (DASH-545).
            <InlineBanner
              tone="crit"
              title={
                metricsError.includes(' 403')
                  ? 'Нет прав на просмотр метрик хоста'
                  : 'Не удалось загрузить метрики хоста'
              }
              description={
                metricsError.includes(' 403')
                  ? 'Обратитесь к администратору за правом host:metrics.'
                  : metricsError
              }
            />
          ) : (
            <>
              <Skeleton variant="card" count={2} label="Загружаем метрики хоста" />
              <Skeleton variant="card" count={2} />
            </>
          )
        ) : (
          <>
            <CpuTile info={info} metrics={metrics} onOpen={() => setOpenMetric('cpu')} />
            <RamTile metrics={metrics} onOpen={() => setOpenMetric('ram')} />
            {/* Идентификатор нужен сценарию e2e, который открывает детализацию диска. */}
            <div data-testid="disk-card">
              <DiskTile metrics={metrics} diskBreakdown={diskBreakdown} onOpen={onDiskClick} />
            </div>
            <NetworkTile metrics={metrics} onOpen={() => setOpenMetric('net')} />
          </>
        )}
      </CardBody>

      <SystemRow info={info} metrics={metrics} />
      {metrics ? (
        <MetricHistoryModal
          open={openMetric !== null}
          onClose={() => setOpenMetric(null)}
          metric={openMetric ?? 'cpu'}
          ramTotalBytes={metrics.ram_total_bytes}
          diskTotalBytes={metrics.disk_total_bytes}
        />
      ) : null}
    </Card>
  );
}

function CpuTile({
  info,
  metrics,
  onOpen,
}: {
  info: HostInfo;
  metrics: HostMetrics;
  onOpen: () => void;
}) {
  const pct = Math.max(0, Math.min(100, metrics.cpu_percent));
  const tone = THRESHOLD_TILE_TONE[thresholdTone(pct / 100, 0.8, 0.95)];
  const cpuLabel = info.cpu_model && info.cpu_model !== 'unknown' ? info.cpu_model : null;
  const value = `${metrics.cpu_percent.toFixed(1)}%`;
  return (
    <StatTile
      label="CPU"
      size="sm"
      value={value}
      hint={cpuLabel ? `${cpuLabel} · ${info.cpu_cores} ядер` : `${info.cpu_cores} ядер`}
      tone={tone}
      progress={{ pct }}
      onClick={onOpen}
      actionLabel={`CPU ${value} — открыть график за 24 часа`}
    />
  );
}

function RamTile({ metrics, onOpen }: { metrics: HostMetrics; onOpen: () => void }) {
  const total = metrics.ram_total_bytes;
  if (total <= 0) {
    return (
      <StatTile
        label="RAM"
        size="sm"
        value="Нет данных"
        hint="Метрика не пришла"
        onClick={onOpen}
        actionLabel="RAM: нет данных — открыть график за 24 часа"
      />
    );
  }
  const r = ratio(metrics.ram_used_bytes, total);
  const value = formatPercent(metrics.ram_used_bytes, total);
  return (
    <StatTile
      label="RAM"
      size="sm"
      value={value}
      hint={`${formatBytes(metrics.ram_used_bytes)} из ${formatBytes(total)}`}
      tone={THRESHOLD_TILE_TONE[thresholdTone(r, 0.7, 0.85)]}
      progress={{ pct: r * 100 }}
      onClick={onOpen}
      actionLabel={`RAM ${value} — открыть график за 24 часа`}
    />
  );
}

function DiskTile({
  metrics,
  diskBreakdown,
  onOpen,
}: {
  metrics: HostMetrics;
  diskBreakdown: DiskBreakdown | null;
  onOpen: () => void;
}) {
  const total = metrics.disk_total_bytes;
  if (total <= 0) {
    return (
      <StatTile
        label="Диск"
        size="sm"
        value="Нет данных"
        hint="Метрика не пришла"
        onClick={onOpen}
        actionLabel="Диск: нет данных — открыть детализацию"
      />
    );
  }
  const r = ratio(metrics.disk_used_bytes, total);
  const usedPct = r * 100;
  const tone = THRESHOLD_TILE_TONE[thresholdTone(r, 0.75, 0.9)];
  const value = formatPercent(metrics.disk_used_bytes, total);
  const panelPct = diskBreakdown ? Math.min(diskBreakdown.panel_pct, usedPct) : 0;
  const otherPct = diskBreakdown ? Math.max(0, usedPct - panelPct) : 0;
  return (
    <StatTile
      label="Диск"
      size="sm"
      value={value}
      hint={`${formatBytes(metrics.disk_used_bytes)} из ${formatBytes(total)}`}
      tone={tone}
      progress={
        diskBreakdown
          ? {
              segments: [
                { pct: otherPct, tone: 'neutral', label: 'Прочее' },
                { pct: panelPct, tone: 'accent', label: 'Панель' },
              ],
            }
          : { pct: usedPct }
      }
      onClick={onOpen}
      actionLabel={`Диск ${value} — открыть детализацию`}
    />
  );
}

function NetworkTile({ metrics, onOpen }: { metrics: HostMetrics; onOpen: () => void }) {
  const rx = formatBytesPerSec(metrics.net_rx_bytes_per_sec);
  const tx = formatBytesPerSec(metrics.net_tx_bytes_per_sec);
  return (
    <StatTile
      label="Сеть, приём"
      size="sm"
      value={rx}
      hint={`Отдача ${tx}`}
      onClick={onOpen}
      actionLabel={`Сеть: приём ${rx}, отдача ${tx} — открыть график за 24 часа`}
    />
  );
}

function SystemRow({ info, metrics }: { info: HostInfo | null; metrics: HostMetrics | null }) {
  const ip = info && info.ip_addresses.length > 0 ? info.ip_addresses.join(', ') : 'нет данных';
  const docker = info && info.docker_version !== '' ? info.docker_version : 'нет данных';
  const kernel = info?.kernel ?? 'нет данных';
  const load = metrics
    ? `${metrics.load_avg_1m.toFixed(2)} / ${metrics.load_avg_5m.toFixed(2)} / ${metrics.load_avg_15m.toFixed(2)}`
    : 'нет данных';

  return (
    <dl className="mt-auto grid grid-cols-2 gap-x-4 gap-y-2 border-t border-line px-4 py-3">
      <SystemCell label="Ядро" value={kernel} />
      <SystemCell label="Docker" value={docker} />
      <SystemCell label="IP" value={ip} />
      <SystemCell label="Средняя загрузка" value={load} />
    </dl>
  );
}

function SystemCell({ label, value }: { label: string; value: string }) {
  const isMissing = value === 'нет данных';
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {/* Служебный ярлык над значением — единственное место, где §1 разрешает
          заглавные буквы. */}
      <dt className="text-2xs uppercase tracking-[0.06em] text-ink-3">{label}</dt>
      <dd className={`truncate text-xs ${isMissing ? 'text-ink-3' : 'text-ink-2'}`} title={value}>
        {value}
      </dd>
    </div>
  );
}
