'use client';
import { SortableTh, Table, TableBody, TableHead, TableRow, Th } from '@/components/ui';
import { RosterRow } from './RosterRow';
import {
  type Capabilities,
  type RosterMember,
  SORT_DIRECTION_TEXT,
  type SortField,
} from './roster-model';

/**
 * Sortable members table of the clan roster.
 *
 * @param sort Column the roster is sorted by.
 * @param order Direction of that sort.
 * @param onSort Called with the key of a clicked column header.
 * @param busyPlayerIds Members with a request in flight; their row controls are disabled.
 * @param lockedPlayerIds Members whose priority toggle is briefly locked after a change.
 */
export function RosterTable({
  members,
  caps,
  sort,
  order,
  onSort,
  busyPlayerIds,
  lockedPlayerIds,
  onChangeRole,
  onRemove,
  onTransfer,
  onTogglePriority,
}: {
  members: RosterMember[];
  caps: Capabilities;
  sort: SortField;
  order: 'asc' | 'desc';
  onSort: (key: string) => void;
  busyPlayerIds: ReadonlySet<string>;
  lockedPlayerIds: ReadonlySet<string>;
  onChangeRole: (playerId: string, role: string) => void;
  onRemove: (member: RosterMember) => void;
  onTransfer: (member: RosterMember) => void;
  onTogglePriority: (member: RosterMember, enabled: boolean) => void;
}) {
  return (
    <Table ariaLabel="Участники клана">
      <TableHead>
        <TableRow>
          <SortableTh
            sortKey="name"
            activeKey={sort}
            direction={order}
            onSort={onSort}
            label="Участник"
            directionText={SORT_DIRECTION_TEXT}
          />
          <SortableTh
            sortKey="role"
            activeKey={sort}
            direction={order}
            onSort={onSort}
            label="Роль"
            directionText={SORT_DIRECTION_TEXT}
          />
          <SortableTh
            sortKey="priority"
            activeKey={sort}
            direction={order}
            onSort={onSort}
            label="Приоритет"
            directionText={SORT_DIRECTION_TEXT}
          />
          <SortableTh
            sortKey="joined_at"
            activeKey={sort}
            direction={order}
            onSort={onSort}
            label="Вступил"
            directionText={SORT_DIRECTION_TEXT}
          />
          <SortableTh
            sortKey="last_seen"
            activeKey={sort}
            direction={order}
            onSort={onSort}
            label="Был(а)"
            directionText={SORT_DIRECTION_TEXT}
          />
          <SortableTh
            sortKey="online"
            activeKey={sort}
            direction={order}
            onSort={onSort}
            label="Наиграно (60 дн.)"
            directionText={SORT_DIRECTION_TEXT}
            align="right"
          />
          <Th align="right">Действия</Th>
        </TableRow>
      </TableHead>
      <TableBody>
        {members.map((member) => (
          <RosterRow
            key={member.player_id}
            member={member}
            caps={caps}
            busy={busyPlayerIds.has(member.player_id)}
            locked={lockedPlayerIds.has(member.player_id)}
            onChangeRole={onChangeRole}
            onRemove={onRemove}
            onTransfer={onTransfer}
            onTogglePriority={onTogglePriority}
          />
        ))}
      </TableBody>
    </Table>
  );
}
