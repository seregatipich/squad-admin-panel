'use client';
import Link from 'next/link';
import {
  Badge,
  Button,
  Checkbox,
  IconButton,
  Select,
  TableRow,
  Td,
  TrashIcon,
} from '@/components/ui';
import {
  type Capabilities,
  formatMemberDate,
  formatOnlineDuration,
  memberRoleLabel,
  type RosterMember,
} from './roster-model';

/**
 * One member row of the clan roster: role selector, priority toggle and the
 * leadership-transfer and removal actions the viewer's capabilities allow.
 */
export function RosterRow({
  member,
  caps,
  busy,
  locked = false,
  onChangeRole,
  onRemove,
  onTransfer,
  onTogglePriority,
}: {
  member: RosterMember;
  caps: Capabilities;
  busy: boolean;
  /** True for `PRIORITY_LOCK_MS` after a successful toggle, to stop a rapid re-click racing the server's pool-limit check. */
  locked?: boolean;
  onChangeRole: (playerId: string, role: string) => void;
  onRemove: (member: RosterMember) => void;
  onTransfer: (member: RosterMember) => void;
  onTogglePriority: (member: RosterMember, enabled: boolean) => void;
}) {
  const isLeader = member.member_role === 'leader';
  const canEditThisRole = caps.canManageFull && !isLeader;
  const canRemoveThis =
    !isLeader && (caps.canManageFull || (caps.canRemoveMembers && member.member_role === 'member'));
  // A deputy toggles priority for rank-and-file members only, as the API enforces.
  const canTogglePriorityThis =
    caps.canManageFull || (caps.canTogglePriority && member.member_role === 'member');

  return (
    <TableRow interactive>
      <Td>
        <Link
          href={`/all-players/${member.player_id}`}
          className="text-accent no-underline hover:brightness-110"
        >
          {member.canonical_name}
        </Link>
      </Td>
      <Td>
        {canEditThisRole ? (
          <Select
            size="sm"
            aria-label={`Роль участника ${member.canonical_name}`}
            value={member.member_role}
            disabled={busy}
            onChange={(e) => onChangeRole(member.player_id, e.target.value)}
          >
            <option value="deputy">Зам</option>
            <option value="member">Участник</option>
          </Select>
        ) : isLeader ? (
          <Badge tone="warn">{memberRoleLabel(member.member_role)}</Badge>
        ) : (
          <span className="text-ink-2">{memberRoleLabel(member.member_role)}</span>
        )}
      </Td>
      <Td>
        {member.reserve_from_role ? (
          <span
            className="inline-flex items-center gap-1.5 text-ink-3"
            title="Приоритет из другого источника"
          >
            <input type="checkbox" checked disabled readOnly className="size-3.5 accent-ink-3" />
            <span className="text-xs">роль</span>
          </span>
        ) : canTogglePriorityThis ? (
          // Подпись скрыта визуально: колонка уже названа заголовком, но без
          // доступного имени флажок нем для скринридера.
          <Checkbox
            label={<span className="sr-only">Приоритет в очереди</span>}
            checked={member.has_priority}
            disabled={busy || locked}
            onChange={(e) => onTogglePriority(member, e.target.checked)}
            title={locked ? 'Подождите несколько секунд перед следующим изменением' : undefined}
          />
        ) : (
          <span className="text-ink-2">{member.has_priority ? 'да' : '—'}</span>
        )}
      </Td>
      <Td className="whitespace-nowrap text-ink-2">{formatMemberDate(member.joined_at)}</Td>
      <Td className="whitespace-nowrap text-ink-2">{formatMemberDate(member.last_seen_at)}</Td>
      <Td numeric className="text-ink-2">
        {formatOnlineDuration(member.online_60d_seconds)}
      </Td>
      <Td align="right">
        <div className="flex items-center justify-end gap-2">
          {caps.canManageFull && !isLeader ? (
            <Button size="sm" disabled={busy} onClick={() => onTransfer(member)}>
              Передать лидерство
            </Button>
          ) : null}
          {canRemoveThis ? (
            <IconButton
              size="sm"
              tone="destructive"
              icon={<TrashIcon />}
              label={`Удалить ${member.canonical_name} из клана`}
              disabled={busy}
              onClick={() => onRemove(member)}
            />
          ) : null}
        </div>
      </Td>
    </TableRow>
  );
}
