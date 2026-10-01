'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BulkModerationModal, type BulkModerationTarget } from '@/components/BulkModerationModal';
import { SquadMessageModal, type SquadMessageTarget } from '@/components/SquadMessageModal';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  InlineBanner,
  SkeletonTable,
} from '@/components/ui';
import { apiFetch } from '@/lib/api';
import { useLiveBusState, useLiveSubscription } from '@/lib/use-live-bus';
import { usePolledResource } from '@/lib/use-polled-resource';
import { QuickModerationDialog, type QuickRequest, quickAbilities } from './QuickModerationDialog';
import { TeamRoster } from './RosterTeams';
import { groupRosterByTeam, type RosterResponse, sortRoster } from './roster-format';

const BULK_KEYS = ['mod:warn', 'mod:kick', 'mod:ban_temp', 'mod:ban_perm'] as const;

export function LivePlayers({
  serverId,
  canChat = false,
  modPermissions = [],
}: {
  serverId: string;
  /** Shows the per-squad "message" button. Hidden without the 'chat' squad permission. */
  canChat?: boolean;
  /**
   * The caller's `mod:*` catalog keys from `GET /api/v1/me` (MOD-4, #61).
   * Multi-select and the bulk action bar stay hidden unless at least one of
   * them is present; the API enforces the same keys independently.
   */
  modPermissions?: readonly string[];
}) {
  // Никакого опроса по таймеру: список ведёт шина. worker-rcon публикует
  // `rcon.roster` сразу после каждого обновления состава, и строка появляется
  // ровно тогда, когда игрок зашёл, а не на следующем тике часов.
  //
  // Событий достаточно, пока сокет жив, поэтому единственное, что здесь
  // остаётся, — перечитать список после обрыва: за время, пока шина
  // переподключалась, события потерялись. То же самое при возврате на вкладку,
  // которую браузер усыпил вместе с сокетом.
  //
  // Загрузки идут из шины, возврата на вкладку и после модерации и могут
  // завершиться не по порядку: хук применяет только ответ самого свежего
  // запроса, а после смены сервера или размонтирования прежний отбрасывает.
  const rosterPath = `/api/v1/servers/${serverId}/roster`;
  const {
    data: roster = null,
    errorMessage: err,
    refresh: load,
  } = usePolledResource<RosterResponse>(
    rosterPath,
    async (signal) => {
      const body = await apiFetch<RosterResponse>(rosterPath, { signal, timeoutMs: null });
      if (!Array.isArray(body?.players)) throw new Error('Некорректный ответ сервера');
      return body;
    },
    { pauseWhenHidden: true },
  );
  const [squadTarget, setSquadTarget] = useState<SquadMessageTarget | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [quick, setQuick] = useState<QuickRequest | null>(null);

  const canBulk = BULK_KEYS.some((key) => modPermissions.includes(key));

  const toggleSelected = useCallback((playerId: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(playerId)) next.delete(playerId);
      else next.add(playerId);
      return next;
    });
  }, []);

  const busState = useLiveBusState();
  const previousBusState = useRef(busState);
  useEffect(() => {
    if (previousBusState.current !== 'open' && busState === 'open') void load();
    previousBusState.current = busState;
  }, [busState, load]);

  const onRoster = useCallback(
    (event: { data: { server_id: string } }) => {
      if (event.data.server_id === serverId) void load();
    },
    [serverId, load],
  );
  useLiveSubscription('rcon.roster', onRoster);

  const players = useMemo(() => (roster ? sortRoster(roster.players) : []), [roster]);
  const { teams, unaffiliated } = useMemo(
    () =>
      groupRosterByTeam(players, {
        teams: roster?.teams,
        squads: roster?.squads,
        teamFactions: roster?.team_factions,
      }),
    [players, roster],
  );
  // Only roster entries resolved to a panel player can be bulk-targeted —
  // the API takes player uuids, not roster slots.
  const selectable: BulkModerationTarget[] = players.flatMap((player) =>
    player.player_id ? [{ playerId: player.player_id, name: player.name }] : [],
  );
  const bulkTargets = selectable.filter((target) => selected.has(target.playerId));

  // A player who left the server (or logged back in) must not stay in — or
  // silently re-enter — the bulk-action selection once they drop out of the
  // current roster.
  useEffect(() => {
    if (!roster) return;
    const rosterPlayerIds = new Set(
      roster.players.flatMap((player) => (player.player_id ? [player.player_id] : [])),
    );
    setSelected((current) => {
      const next = new Set([...current].filter((id) => rosterPlayerIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [roster]);
  const abilities = quickAbilities(modPermissions);

  const rowProps = {
    serverId,
    canChat,
    canBulk,
    abilities,
    selected,
    onToggleSelected: toggleSelected,
    onSelectGroup: setSelected,
    onMessageSquad: setSquadTarget,
    onQuickAction: setQuick,
  };

  return (
    <Card padding="none" as="section">
      <CardHeader title="Игроки онлайн" count={roster ? players.length : undefined} />

      {canBulk && bulkTargets.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-line bg-raised px-4 py-2">
          <span className="text-xs text-ink-2">Выбрано: {bulkTargets.length}</span>
          <Button size="sm" variant="primary" onClick={() => setBulkOpen(true)}>
            Массовое действие
          </Button>
          <Button size="sm" onClick={() => setSelected(new Set())}>
            Снять выделение
          </Button>
        </div>
      ) : null}

      {err ? (
        <CardBody>
          <InlineBanner
            tone="crit"
            title="Не удалось загрузить список игроков"
            description={err}
            action={
              <Button size="sm" onClick={() => void load()}>
                Повторить
              </Button>
            }
          />
        </CardBody>
      ) : null}

      {!roster && !err ? (
        <CardBody>
          <SkeletonTable rows={6} cols={6} label="Загружается список игроков" />
        </CardBody>
      ) : null}

      {roster && players.length === 0 && !err ? (
        <EmptyState
          variant="initial"
          title="На сервере никого нет"
          description="Никто не подключён либо RCON-опрос ещё не выполнялся."
        />
      ) : null}

      {players.length > 0 ? (
        // Две колонки — по одной на команду, как на экране отрядов в игре.
        // Ниже `xl` строка с действиями не помещается в половину ширины, и
        // команды встают друг под другом. `items-start` снимает растягивание
        // по высоте: колонка меньшей команды заканчивается на своём последнем
        // игроке, а не тянется пустотой до высоты соседней.
        <CardBody className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
          {teams.map((team) => (
            <TeamRoster key={team.team_id} team={team} {...rowProps} />
          ))}
          {unaffiliated.length > 0 ? (
            <div className="xl:col-span-2">
              <TeamRoster
                team={{
                  team_id: null,
                  name: null,
                  faction: null,
                  squads: [
                    {
                      team_id: null,
                      squad_id: null,
                      players: unaffiliated,
                      leader: null,
                      name: null,
                      locked: false,
                      is_command_squad: false,
                    },
                  ],
                  player_count: unaffiliated.length,
                }}
                {...rowProps}
              />
            </div>
          ) : null}
        </CardBody>
      ) : null}

      <SquadMessageModal
        target={squadTarget}
        onOpenChange={(open) => !open && setSquadTarget(null)}
      />

      <BulkModerationModal
        serverId={serverId}
        targets={bulkOpen ? bulkTargets : null}
        permissions={modPermissions}
        onOpenChange={(open) => {
          if (!open) setBulkOpen(false);
        }}
        onApplied={() => {
          setSelected(new Set());
          void load();
        }}
      />

      <QuickModerationDialog
        serverId={serverId}
        request={quick}
        permissions={modPermissions}
        onClose={() => setQuick(null)}
        onApplied={() => {
          setQuick(null);
          void load();
        }}
      />
    </Card>
  );
}
