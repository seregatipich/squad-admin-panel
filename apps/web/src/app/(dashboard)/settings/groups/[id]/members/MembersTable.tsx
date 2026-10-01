'use client';

import Link from 'next/link';
import {
  Button,
  Card,
  Checkbox,
  EmptyState,
  SkeletonTable,
  Table,
  TableBody,
  TableHead,
  TableRow,
  Td,
  Th,
} from '@/components/ui';
import type { Member, MembersResponse } from './members-shared';

interface MembersTableProps {
  /** `null` while the first page is loading. */
  data: MembersResponse | null;
  /** Whether the viewer may select and remove members. */
  canManage: boolean;
  /** Current search text; decides the empty-state wording. */
  query: string;
  selected: ReadonlySet<string>;
  onToggleAll: (items: Member[]) => void;
  onToggleOne: (playerId: string) => void;
  onRemove: (member: Member) => void;
  onResetFilter: () => void;
}

/** The role's member list: skeleton while loading, empty state, or the selectable table. */
export function MembersTable({
  data,
  canManage,
  query,
  selected,
  onToggleAll,
  onToggleOne,
  onRemove,
  onResetFilter,
}: MembersTableProps) {
  const filtered = query.trim() !== '';
  const allOnPageSelected =
    data !== null && data.items.length > 0 && data.items.every((m) => selected.has(m.id));

  return (
    <Card padding="none">
      {data === null ? (
        <div className="p-3">
          <SkeletonTable rows={6} cols={5} label="Загрузка списка участников" />
        </div>
      ) : data.items.length === 0 ? (
        <EmptyState
          variant={filtered ? 'filtered' : 'initial'}
          title={filtered ? 'Никто не найден по запросу' : 'Нет участников'}
          description={
            filtered
              ? 'Ни один участник роли не подходит под запрос.'
              : 'Роль ещё никому не выдана. Добавьте игрока, чтобы он получил её права.'
          }
          action={
            filtered ? (
              <Button size="sm" onClick={() => onResetFilter()}>
                Сбросить фильтр
              </Button>
            ) : null
          }
        />
      ) : (
        <Table layout="fixed" ariaLabel="Участники роли">
          <TableHead>
            <tr>
              {canManage ? (
                <Th width="2.75rem">
                  <Checkbox
                    label={<span className="sr-only">Выбрать всех на странице</span>}
                    checked={allOnPageSelected}
                    onChange={() => onToggleAll(data.items)}
                  />
                </Th>
              ) : null}
              <Th>Никнейм</Th>
              <Th width="11rem">SteamID64</Th>
              <Th width="13rem">Комментарий</Th>
              <Th width="11rem">Был(а)</Th>
              <Th align="right" width="7rem">
                Действие
              </Th>
            </tr>
          </TableHead>
          <TableBody>
            {data.items.map((m) => (
              <TableRow key={m.id} interactive selected={selected.has(m.id)}>
                {canManage ? (
                  <Td>
                    <Checkbox
                      label={<span className="sr-only">{`Выбрать ${m.canonical_name}`}</span>}
                      checked={selected.has(m.id)}
                      onChange={() => onToggleOne(m.id)}
                    />
                  </Td>
                ) : null}
                <Td truncate>
                  <Link
                    href={`/all-players/${m.id}`}
                    className="text-accent no-underline hover:brightness-110"
                  >
                    {m.canonical_name}
                  </Link>
                </Td>
                <Td className="font-mono text-xs">{m.steam_id64 ?? '—'}</Td>
                <Td truncate className="text-xs text-ink-3">
                  {m.role_comment ?? '—'}
                </Td>
                <Td className="text-xs text-ink-3">
                  {new Date(m.last_seen_at).toLocaleString('ru-RU')}
                </Td>
                <Td align="right">
                  {canManage ? (
                    <Button size="sm" onClick={() => onRemove(m)}>
                      Снять
                    </Button>
                  ) : null}
                </Td>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}
