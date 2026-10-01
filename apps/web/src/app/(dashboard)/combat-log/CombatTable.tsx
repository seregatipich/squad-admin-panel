'use client';
import Link from 'next/link';
import {
  Badge,
  type BadgeTone,
  Button,
  Card,
  EmptyState,
  SkeletonTable,
  SortableTh,
  type SortDirection,
  Table,
  TableBody,
  TableHead,
  TableRow,
  Td,
  Th,
} from '@/components/ui';
import {
  type CombatApiRow,
  type CombatPlayer,
  eventTypeMeta,
  formatDamage,
  formatEventTime,
  playerHref,
  playerLabel,
  type SortDir,
  shortServerLabel,
} from './helpers';

/**
 * Тип боевого события. Оттенки различают соседние категории и ничего не
 * сообщают о состоянии системы: смысл несёт подпись внутри метки (§5).
 */
const EVENT_TONE: Record<string, BadgeTone> = {
  death: 'crit',
  damage: 'warn',
  wound: 'warn',
  revive: 'good',
};

/** Направление сортировки колонки урона читается величиной, а не словом «по». */
const DAMAGE_DIRECTION_TEXT: Record<SortDirection, string> = {
  desc: 'сначала больший урон',
  asc: 'сначала меньший урон',
};

function PlayerLink({ player }: { player: CombatPlayer | null }) {
  const href = playerHref(player);
  const label = playerLabel(player);
  if (href) {
    return (
      <Link href={href} className="font-medium text-accent no-underline hover:brightness-110">
        {label}
      </Link>
    );
  }
  return <span className="text-ink-3">{label}</span>;
}

/** «TK» — принятое в Squad сокращение тимкилла, поэтому остаётся как есть. */
function TeamkillBadge() {
  return (
    <Badge tone="crit" size="sm" title="Тимкилл">
      TK
    </Badge>
  );
}

function EventTypeBadge({ eventType }: { eventType: string }) {
  const meta = eventTypeMeta(eventType);
  return <Badge tone={EVENT_TONE[eventType] ?? 'neutral'}>{meta.labelRu}</Badge>;
}

export function CombatTable({
  rows,
  loading,
  filtersApplied,
  onReset,
  showServer,
  serverNames,
  damageVisible,
  damageSort,
  onToggleDamageSort,
}: {
  rows: CombatApiRow[];
  loading: boolean;
  filtersApplied: boolean;
  onReset: () => void;
  showServer: boolean;
  serverNames: Map<string, string>;
  damageVisible: boolean;
  damageSort: SortDir;
  onToggleDamageSort: () => void;
}) {
  if (loading && rows.length === 0) {
    return (
      <Card padding="sm">
        <SkeletonTable rows={10} cols={showServer ? 7 : 6} label="Загрузка боевого лога" />
      </Card>
    );
  }
  if (!loading && rows.length === 0) {
    return (
      <Card padding="none">
        <EmptyState
          variant={filtersApplied ? 'filtered' : 'initial'}
          title={filtersApplied ? 'Нет совпадений.' : 'Боевых событий пока нет'}
          description={
            filtersApplied
              ? 'Ни одно событие не подходит под включённые фильтры.'
              : 'Панель ещё не записала ни одного боевого события.'
          }
          action={
            filtersApplied ? (
              <Button size="sm" onClick={onReset}>
                Сбросить фильтры
              </Button>
            ) : undefined
          }
        />
      </Card>
    );
  }

  return (
    <>
      <Card padding="none" className="hidden overflow-hidden md:block">
        <Table ariaLabel="Боевые события" className="min-w-[720px]">
          <TableHead>
            <tr>
              <Th>Время</Th>
              {showServer ? <Th>Сервер</Th> : null}
              <Th>Кто</Th>
              <Th>Кого</Th>
              <Th>Оружие</Th>
              {damageVisible ? (
                <SortableTh
                  sortKey="damage"
                  activeKey="damage"
                  direction={damageSort}
                  onSort={onToggleDamageSort}
                  label="Урон"
                  directionText={DAMAGE_DIRECTION_TEXT}
                  align="right"
                />
              ) : null}
              <Th>TK</Th>
            </tr>
          </TableHead>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id} interactive>
                <Td className="whitespace-nowrap text-xs text-ink-3">
                  <span title={row.occurredAt}>{formatEventTime(row.occurredAt)}</span>
                </Td>
                {showServer ? (
                  <Td className="whitespace-nowrap text-xs text-ink-2">
                    {shortServerLabel(serverNames, row.serverId)}
                  </Td>
                ) : null}
                <Td className="whitespace-nowrap">
                  <PlayerLink player={row.attacker} />
                </Td>
                <Td className="whitespace-nowrap">
                  <PlayerLink player={row.victim} />
                </Td>
                <Td>
                  <span className="flex items-center gap-2">
                    <EventTypeBadge eventType={row.eventType} />
                    <span className="text-xs">{row.weapon ?? '—'}</span>
                  </span>
                </Td>
                {damageVisible ? (
                  <Td numeric className="whitespace-nowrap text-xs">
                    {formatDamage(row.damage)}
                  </Td>
                ) : null}
                <Td>
                  {row.isTeamkill ? <TeamkillBadge /> : <span className="text-ink-4">—</span>}
                </Td>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      <ul className="space-y-2 md:hidden">
        {rows.map((row) => (
          <li key={row.id}>
            <Card padding="sm">
              <div className="mb-2 flex items-center justify-between gap-2">
                <EventTypeBadge eventType={row.eventType} />
                <span className="text-2xs tabular-nums text-ink-3" title={row.occurredAt}>
                  {formatEventTime(row.occurredAt)}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <PlayerLink player={row.attacker} />
                <span aria-hidden="true" className="text-ink-3">
                  →
                </span>
                <PlayerLink player={row.victim} />
                {row.isTeamkill ? <TeamkillBadge /> : null}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 text-xs text-ink-3">
                <span>{row.weapon ?? '—'}</span>
                {showServer ? <span>{shortServerLabel(serverNames, row.serverId)}</span> : null}
                {damageVisible ? (
                  <span className="tabular-nums">Урон: {formatDamage(row.damage)}</span>
                ) : null}
              </div>
            </Card>
          </li>
        ))}
      </ul>
    </>
  );
}
