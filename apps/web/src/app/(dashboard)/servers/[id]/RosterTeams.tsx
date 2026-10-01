'use client';
import Link from 'next/link';
import { useEffect, useId, useState } from 'react';
import type { BulkModerationTarget } from '@/components/BulkModerationModal';
import { DirectMessageButton } from '@/components/DirectMessageModal';
import type { SquadMessageTarget } from '@/components/SquadMessageModal';
import {
  Checkbox,
  IconButton,
  LockIcon,
  Table,
  TableBody,
  TableHead,
  TableRow,
  Td,
  Th,
  WarningIcon,
} from '@/components/ui';
import type { QuickRequest, quickAbilities } from './QuickModerationDialog';
import {
  formatTimeOnServer,
  kitLabel,
  type RosterPlayer,
  SQUAD_MAX_SIZE,
  type SquadGroup,
  squadLabel,
  type TeamColumn,
  teamLabel,
} from './roster-format';
import { SquadCrown } from './squad-crown';

export interface RosterRowsProps {
  serverId: string;
  canChat: boolean;
  canBulk: boolean;
  abilities: ReturnType<typeof quickAbilities>;
  selected: ReadonlySet<string>;
  onToggleSelected: (playerId: string) => void;
  onSelectGroup: (update: (current: ReadonlySet<string>) => ReadonlySet<string>) => void;
  onMessageSquad: (target: SquadMessageTarget) => void;
  onQuickAction: (request: QuickRequest) => void;
}

/** Колонка одной команды: шапка с фракцией и таблица её отрядов. */
export function TeamRoster({
  team,
  ...rowProps
}: RosterRowsProps & {
  /** `team_id: null` — блок игроков, у которых команда ещё не определена. */
  team: Omit<TeamColumn, 'team_id'> & { team_id: number | null };
}) {
  const headingId = useId();
  const title =
    team.team_id == null
      ? 'Без команды'
      : team.name
        ? `${team.name}`
        : `Команда ${teamLabel(team.team_id)}`;
  const subtitle =
    team.team_id == null
      ? null
      : [team.name ? `Команда ${teamLabel(team.team_id)}` : null, team.faction]
          .filter((part) => part != null)
          .join(' · ') || null;
  const squadCount = team.squads.filter((group) => group.squad_id != null).length;

  // Таблица в фиксированной раскладке: в авто-режиме длинный ник без пробелов
  // задаёт минимальную ширину колонки, таблица вырастает шире своей половины и
  // уезжает под соседнюю. С фиксированными колонками остаток получает имя, и
  // оно обрезается многоточием.
  return (
    <section aria-labelledby={headingId} className="min-w-0 rounded-card border border-line">
      <header className="flex items-center justify-between gap-3 border-b border-line bg-raised px-3 py-2">
        <div className="flex min-w-0 items-baseline gap-2">
          <h3 id={headingId} className="truncate text-[13px] font-semibold text-ink">
            {title}
          </h3>
          {subtitle ? <span className="shrink-0 text-xs text-ink-3">{subtitle}</span> : null}
        </div>
        <span className="shrink-0 text-xs tabular-nums text-ink-3">
          {team.player_count} {pluralPlayers(team.player_count)}
          {team.team_id != null ? ` · ${squadCount} ${pluralSquads(squadCount)}` : ''}
        </span>
      </header>
      {team.squads.length === 0 ? (
        <p className="px-3 py-4 text-center text-xs text-ink-3">В этой команде пока никого нет</p>
      ) : (
        <Table ariaLabel={`Игроки: ${title}`} layout="fixed">
          <TableHead>
            <TableRow>
              {rowProps.canBulk ? (
                <Th className="w-8">
                  <span className="sr-only">Выбор</span>
                </Th>
              ) : null}
              <Th>Игрок</Th>
              <Th align="right" className="w-20">
                На сервере
              </Th>
              <Th align="right" className="w-52">
                Действия
              </Th>
            </TableRow>
          </TableHead>
          <TableBody>
            {team.squads.map((group) => (
              <SquadGroupRows
                key={`${group.team_id}:${group.squad_id}`}
                group={group}
                {...rowProps}
              />
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}

function pluralPlayers(count: number): string {
  return pluralize(count, ['игрок', 'игрока', 'игроков']);
}

function pluralSquads(count: number): string {
  return pluralize(count, ['отряд', 'отряда', 'отрядов']);
}

function pluralize(count: number, forms: readonly [string, string, string]): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return forms[1];
  return forms[2];
}

function SquadGroupRows({
  group,
  serverId,
  canChat,
  canBulk,
  abilities,
  selected,
  onToggleSelected,
  onSelectGroup,
  onMessageSquad,
  onQuickAction,
}: RosterRowsProps & { group: SquadGroup }) {
  const messageable = canChat && group.team_id != null && group.squad_id != null;
  const squadTitle =
    group.squad_id == null
      ? 'Без отряда'
      : group.name
        ? group.name
        : `Отряд ${squadLabel(group.squad_id)}`;
  // Полное имя цели для окна сообщения и подписей — с командой, потому что
  // отряды нумеруются в каждой команде заново.
  const label =
    group.squad_id != null
      ? `Команда ${teamLabel(group.team_id)} · Отряд ${squadLabel(group.squad_id)}${
          group.name ? ` «${group.name}»` : ''
        }`
      : `Команда ${teamLabel(group.team_id)} · Без отряда`;
  const colSpan = 3 + (canBulk ? 1 : 0);
  const groupSelectable = group.players
    .map((player) => player.player_id)
    .filter((id): id is string => id !== null);
  const groupSelected =
    groupSelectable.length > 0 && groupSelectable.every((id) => selected.has(id));

  return (
    <>
      <tr className="bg-raised">
        {/* Не `Th`: заголовок колонки набирается заглавными, а это название
            отряда — смысловой текст, и капслок ему запрещён (§1). */}
        <th
          scope="colgroup"
          colSpan={colSpan}
          className="px-3 py-1.5 text-left text-xs font-semibold text-ink-2"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-2">
              {canBulk && groupSelectable.length > 0 ? (
                <Checkbox
                  label={<span className="sr-only">{`Выделить отряд: ${label}`}</span>}
                  checked={groupSelected}
                  onChange={() =>
                    onSelectGroup((current) => {
                      const next = new Set(current);
                      for (const id of groupSelectable) {
                        if (groupSelected) next.delete(id);
                        else next.add(id);
                      }
                      return next;
                    })
                  }
                />
              ) : null}
              {group.squad_id != null ? (
                <span
                  className="w-5 shrink-0 text-center tabular-nums text-ink-3"
                  title="Номер отряда"
                >
                  {squadLabel(group.squad_id)}
                </span>
              ) : null}
              <span className="truncate">{squadTitle}</span>
              {group.locked ? (
                // Значок сам по себе ничего не сообщает и цветом тоже: подпись
                // уходит в текст для скринридера и во всплывающую подсказку.
                <span className="shrink-0 text-crit" title="Отряд закрыт для входа">
                  <LockIcon className="size-3.5" />
                  <span className="sr-only">Отряд закрыт для входа</span>
                </span>
              ) : null}
              <span className="shrink-0 font-normal tabular-nums text-ink-3">
                {group.squad_id != null
                  ? `${group.players.length}/${SQUAD_MAX_SIZE}`
                  : group.players.length}
              </span>
            </span>
            {messageable ? (
              <IconButton
                size="sm"
                icon={<span aria-hidden="true">✉</span>}
                label={`Сообщение отряду: ${label}`}
                onClick={() =>
                  onMessageSquad({
                    serverId,
                    // biome-ignore lint/style/noNonNullAssertion: guarded by `messageable`
                    teamId: group.team_id!,
                    // biome-ignore lint/style/noNonNullAssertion: guarded by `messageable`
                    squadId: group.squad_id!,
                    label,
                    leaderName: group.leader?.name ?? null,
                  })
                }
              />
            ) : null}
          </div>
        </th>
      </tr>
      {group.players.map((player) => (
        <RosterRow
          key={player.eos_id}
          player={player}
          serverId={serverId}
          canChat={canChat}
          canBulk={canBulk}
          abilities={abilities}
          checked={player.player_id !== null && selected.has(player.player_id)}
          onToggleSelected={onToggleSelected}
          onQuickAction={onQuickAction}
        />
      ))}
    </>
  );
}

/**
 * Колонка «На сервере» со своим секундным таймером: тикает только эта ячейка,
 * а не весь ростер, и не тикает, пока вкладка скрыта.
 */
function TimeOnServer({ firstSeenAt }: { firstSeenAt: string | null }) {
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') setNow(Date.now());
    }, 1000);
    return () => clearInterval(timer);
  }, []);
  return <>{formatTimeOnServer(firstSeenAt, now)}</>;
}

function RosterRow({
  player,
  serverId,
  canChat,
  canBulk,
  abilities,
  checked,
  onToggleSelected,
  onQuickAction,
}: {
  player: RosterPlayer;
  serverId: string;
  canChat: boolean;
  canBulk: boolean;
  abilities: ReturnType<typeof quickAbilities>;
  checked: boolean;
  onToggleSelected: (playerId: string) => void;
  onQuickAction: (request: QuickRequest) => void;
}) {
  // Действия модерации бьют по игроку панели, а не по слоту ростера: строка
  // без `player_id` ещё не сопоставлена с профилем, и целью быть не может.
  const target: BulkModerationTarget | null = player.player_id
    ? { playerId: player.player_id, name: player.name }
    : null;
  const kit = kitLabel(player.role);
  // Колонок SteamID64/EOS в половине ширины нет — идентификаторы остаются в
  // подсказке имени и в досье.
  const identity = [
    player.steam_id64 ? `SteamID64: ${player.steam_id64}` : null,
    `EOS: ${player.eos_id}`,
  ]
    .filter(Boolean)
    .join('\n');

  return (
    <TableRow interactive selected={checked}>
      {canBulk ? (
        <Td>
          <Checkbox
            label={<span className="sr-only">{`Выбрать игрока: ${player.name}`}</span>}
            checked={checked}
            disabled={player.player_id === null}
            title={
              player.player_id === null ? 'Игрок ещё не сопоставлен с профилем панели' : undefined
            }
            onChange={() => player.player_id && onToggleSelected(player.player_id)}
          />
        </Td>
      ) : null}
      <Td>
        <span className="flex min-w-0 items-center gap-1.5">
          {player.is_leader ? (
            <span className="shrink-0 text-warn" title="Командир отряда">
              ★
            </span>
          ) : null}
          {player.squad_crown ? <SquadCrown crown={player.squad_crown} /> : null}
          {player.player_id ? (
            <Link
              href={`/all-players/${player.player_id}`}
              className="truncate text-accent"
              title={identity}
            >
              {player.name}
            </Link>
          ) : (
            <span className="truncate" title={identity}>
              {player.name}
            </span>
          )}
          {kit ? (
            <span className="shrink-0 text-2xs text-ink-3" title={player.role ?? undefined}>
              {kit}
            </span>
          ) : null}
        </span>
      </Td>
      <Td numeric className="whitespace-nowrap">
        <TimeOnServer firstSeenAt={player.first_seen_at} />
      </Td>
      <Td align="right">
        <div className="flex items-center justify-end gap-0.5">
          {target && abilities.warn ? (
            <IconButton
              size="sm"
              icon={<WarningIcon />}
              label={`Предупредить: ${player.name}`}
              onClick={() => onQuickAction({ action: 'warn', target })}
            />
          ) : null}
          {target && abilities.kick ? (
            <IconButton
              size="sm"
              icon={<span aria-hidden="true">⇥</span>}
              label={`Кик: ${player.name}`}
              onClick={() => onQuickAction({ action: 'kick', target })}
            />
          ) : null}
          {target && abilities.ban ? (
            <IconButton
              size="sm"
              tone="destructive"
              icon={<span aria-hidden="true">⊘</span>}
              label={`Бан: ${player.name}`}
              onClick={() => onQuickAction({ action: 'ban', target })}
            />
          ) : null}
          {/* Иконки, а не подписи: в половине ширины текстовые кнопки не
              помещаются в строку, а подпись каждой остаётся в `aria-label` и
              всплывающей подсказке. Досье кнопки не имеет: карточку игрока
              открывает его имя в строке — обычной ссылкой. */}
          <DirectMessageButton
            playerId={player.player_id}
            name={player.name}
            canChat={canChat}
            serverId={serverId}
            variant="icon"
          />
        </div>
      </Td>
    </TableRow>
  );
}
