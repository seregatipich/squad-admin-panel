'use client';
import {
  Badge,
  type BadgeTone,
  Button,
  EmptyState,
  SkeletonTable,
  Table,
  TableBody,
  TableHead,
  TableRow,
  Td,
  Th,
} from '@/components/ui';
import { type EventListItem, formatDateTime, kindLabel, shortServerName } from './helpers';

/**
 * Тон пилюли типа события.
 *
 * Повторяет разбиение `kindTone` из `helpers.ts`, но выдаёт тон дизайн-системы,
 * а не строку классов: помощник — общий модуль со своим владельцем, и цвета
 * оформления в нём остаются те, что были. Смысл всё равно несёт подпись
 * `kindLabel`, а не цвет (§5).
 */
function kindBadgeTone(kind: string): BadgeTone {
  if (kind.startsWith('server.crashed') || kind.endsWith('.failed')) return 'crit';
  if (kind.startsWith('player.connected') || kind.startsWith('match.started')) return 'good';
  if (
    kind.startsWith('player.disconnected') ||
    kind.startsWith('match.ended') ||
    kind.startsWith('banname.matched')
  ) {
    return 'warn';
  }
  return 'neutral';
}

/** Table of the loaded events with its loading and empty states. */
export function EventList({
  items,
  loading,
  filtersApplied,
  showServer,
  onSelect,
  onResetFilters,
}: {
  items: EventListItem[];
  loading: boolean;
  filtersApplied: boolean;
  showServer: boolean;
  onSelect: (event: EventListItem) => void;
  onResetFilters: () => void;
}) {
  if (loading && items.length === 0) {
    return (
      <div className="p-3">
        <SkeletonTable rows={8} cols={showServer ? 5 : 4} label="Загружаем журнал событий" />
      </div>
    );
  }
  if (!loading && items.length === 0) {
    return (
      <EmptyState
        variant={filtersApplied ? 'filtered' : 'initial'}
        title={filtersApplied ? 'Ничего не нашлось' : 'Событий пока нет'}
        description={
          filtersApplied
            ? 'Ни одно событие не подходит под выбранные фильтры.'
            : 'Как только серверы начнут присылать события, они появятся здесь.'
        }
        action={filtersApplied ? <Button onClick={onResetFilters}>Сбросить фильтр</Button> : null}
      />
    );
  }
  return (
    <Table dense ariaLabel="События">
      <TableHead>
        <TableRow>
          <Th>Время</Th>
          <Th>Тип</Th>
          {showServer ? <Th>Сервер</Th> : null}
          <Th>Кто</Th>
          <Th align="right">Идентификатор</Th>
        </TableRow>
      </TableHead>
      <TableBody>
        {items.map((event) => (
          <TableRow key={event.event_id} interactive>
            <Td className="whitespace-nowrap">
              {/* Конверт открывается в модальном окне, поэтому здесь настоящая
                  кнопка, а не ссылка и не обработчик на строке. */}
              <Button
                variant="plain"
                size="sm"
                onClick={() => onSelect(event)}
                title={`Показать конверт события ${event.event_id.slice(0, 8)}`}
              >
                {formatDateTime(event.occurred_at)}
              </Button>
            </Td>
            <Td>
              <Badge size="sm" tone={kindBadgeTone(event.kind)}>
                {kindLabel(event.kind)}
              </Badge>
            </Td>
            {showServer ? <Td className="text-ink-2">{shortServerName(event)}</Td> : null}
            <Td truncate className="text-ink-2">
              {event.actor_nickname ?? '—'}
            </Td>
            <Td numeric className="font-mono text-2xs text-ink-3">
              {event.event_id.slice(0, 8)}
            </Td>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
