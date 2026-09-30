'use client';
import { useMemo } from 'react';
import {
  Badge,
  Button,
  ButtonLink,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  formatClock,
  SegmentedControl,
  SkeletonTable,
  Table,
  TableBody,
  TableHead,
  TableRow,
  Td,
  Th,
  Toolbar,
} from '@/components/ui';
import { useIntlLocale } from '@/i18n/LocaleProvider';
import { ACTIVITY_FILTERS, type ActivityFilter } from './shared';
import type { AuditRow } from './types';

// Журнал сокращает только UUID: восемь первых символов однозначно узнаются
// в таблице, а `localhost`, `days:30` или `1` от усечения лишь теряют смысл.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Роль инициатора события из журнала; неизвестное значение показывается как есть. */
const ACTOR_KIND_LABEL: Record<string, string> = {
  steam: 'Оператор',
  user: 'Пользователь',
  system: 'Система',
  bot: 'Бот',
};

const ACTIVITY_FILTER_LABEL: Record<ActivityFilter, string> = {
  all: 'Всё',
  user: 'Пользователь',
  server: 'Серверы',
  infra: 'Инфра',
  errors: 'Ошибки',
};

export function RecentActivity({
  rows,
  loading,
  error,
  filter,
  onFilter,
}: {
  rows: AuditRow[];
  loading: boolean;
  error: string | null;
  filter: ActivityFilter;
  onFilter: (f: ActivityFilter) => void;
}) {
  const filtered = useMemo(
    () => rows.filter((r) => matchesActivityFilter(r, filter)),
    [rows, filter],
  );
  return (
    <Card as="section" padding="none" className="flex h-full flex-col">
      <CardHeader
        title="Последние действия"
        count={`${filtered.length}/${rows.length}`}
        actions={
          <ButtonLink href="/audit" variant="plain" size="sm">
            Журнал действий
          </ButtonLink>
        }
      />
      <CardBody padding="sm" className="border-b border-line">
        <Toolbar
          filters={
            <SegmentedControl
              ariaLabel="Фильтр событий"
              size="sm"
              value={filter}
              onChange={(value) => onFilter(value as ActivityFilter)}
              items={ACTIVITY_FILTERS.map((f) => ({
                value: f,
                label: ACTIVITY_FILTER_LABEL[f],
              }))}
            />
          }
        />
      </CardBody>
      {loading ? (
        <CardBody>
          <SkeletonTable rows={5} cols={4} label="Загружаем последние действия" />
        </CardBody>
      ) : rows.length === 0 && error ? (
        // Ошибка молча проглатывалась: пустой журнал из-за сбоя API/Redis или
        // отсутствия права audit:view выглядел неотличимо от «событий пока
        // правда нет» (DASH-545).
        <EmptyState
          variant="initial"
          title={error.includes(' 403') ? 'Нет прав на просмотр журнала' : 'Журнал не загрузился'}
          description={
            error.includes(' 403') ? 'Обратитесь к администратору за правом audit:view.' : error
          }
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          variant={rows.length === 0 ? 'initial' : 'filtered'}
          title={rows.length === 0 ? 'Действий пока нет' : 'Под фильтр ничего не подходит'}
          description={
            rows.length === 0
              ? 'Как только в панели что-то произойдёт, событие появится здесь.'
              : 'Выберите другой фильтр или покажите все события.'
          }
          action={
            rows.length === 0 ? undefined : (
              <Button size="sm" onClick={() => onFilter('all')}>
                Сбросить фильтр
              </Button>
            )
          }
        />
      ) : (
        <Table dense maxHeight="320px" ariaLabel="Последние действия">
          <TableHead>
            <tr>
              <Th>Время</Th>
              <Th>Кто</Th>
              <Th>Событие</Th>
              <Th>Цель</Th>
              <Th align="right">Итог</Th>
            </tr>
          </TableHead>
          <TableBody>
            {filtered.map((ev) => (
              <ActivityRow key={ev.id} ev={ev} />
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}

function ActivityRow({ ev }: { ev: AuditRow }) {
  const locale = useIntlLocale();
  const severity = severityFromStatus(ev.status_code);
  const time = new Date(ev.created_at);
  const targetId = ev.target_id
    ? UUID_RE.test(ev.target_id)
      ? ev.target_id.slice(0, 8)
      : ev.target_id
    : null;
  const targetLabel = ev.target_type ? `${ev.target_type}${targetId ? ` · ${targetId}` : ''}` : '—';
  // Без `interactive`: строка журнала никуда не ведёт, а этот флаг примитив
  // резервирует за строками со ссылкой в первой ячейке.
  return (
    <TableRow>
      <Td className="whitespace-nowrap text-xs tabular-nums text-ink-3">
        {formatClock(time, locale) ?? '—'}
      </Td>
      <Td className="text-xs text-ink-2">{ACTOR_KIND_LABEL[ev.actor_kind] ?? ev.actor_kind}</Td>
      <Td className="text-xs text-ink">{ev.action_type}</Td>
      <Td className="text-xs text-ink-3">
        <span className="block max-w-[160px] truncate" title={targetLabel}>
          {targetLabel}
        </span>
      </Td>
      <Td align="right">
        <SeverityBadge severity={severity} statusCode={ev.status_code} />
      </Td>
    </TableRow>
  );
}

function SeverityBadge({
  severity,
  statusCode,
}: {
  severity: 'info' | 'warning' | 'critical';
  statusCode: number | null;
}) {
  const tone = severity === 'critical' ? 'crit' : severity === 'warning' ? 'warn' : 'neutral';
  const label =
    severity === 'critical' ? 'критично' : severity === 'warning' ? 'предупреждение' : 'инфо';
  return (
    <Badge tone={tone} size="sm" title={statusCode != null ? `HTTP ${statusCode}` : 'нет статуса'}>
      {label}
    </Badge>
  );
}

function severityFromStatus(code: number | null): 'info' | 'warning' | 'critical' {
  if (code == null) return 'info';
  if (code >= 500) return 'critical';
  if (code >= 400) return 'warning';
  return 'info';
}

function matchesActivityFilter(row: AuditRow, filter: ActivityFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'errors') return typeof row.status_code === 'number' && row.status_code >= 400;
  if (filter === 'user') {
    return row.actor_kind === 'user' || /^(auth|session|user)\./.test(row.action_type);
  }
  if (filter === 'server') return /^server\./.test(row.action_type);
  if (filter === 'infra') return /^(host|config|depot|bridge)\./.test(row.action_type);
  return true;
}
