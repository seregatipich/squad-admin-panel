'use client';
import Link from 'next/link';
import { useCallback, useEffect, useId, useState } from 'react';
import { BanNickButton } from '@/components/BannedNameRuleModal';
import { BulkModerationModal, type BulkModerationTarget } from '@/components/BulkModerationModal';
import { DirectMessageButton } from '@/components/DirectMessageModal';
import { SquadMessageModal, type SquadMessageTarget } from '@/components/SquadMessageModal';
import {
  AlertDialog,
  Button,
  ButtonLink,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  EmptyState,
  FieldRow,
  IconButton,
  InlineBanner,
  Select,
  SkeletonTable,
  Table,
  TableBody,
  TableHead,
  TableRow,
  Td,
  Textarea,
  Th,
  WarningIcon,
} from '@/components/ui';
import { useLiveSubscription } from '@/lib/use-live-bus';
import {
  formatTimeOnServer,
  groupRosterBySquad,
  type RosterPlayer,
  type RosterResponse,
  type SquadGroup,
  shortEos,
  sortRoster,
  squadLabel,
  teamLabel,
} from './roster-format';

const ROSTER_POLL_MS = 30_000;

const BULK_KEYS = ['mod:warn', 'mod:kick', 'mod:ban_temp', 'mod:ban_perm'] as const;

/** Действие модерации над одним игроком прямо из строки ростера. */
type QuickAction = 'warn' | 'kick' | 'ban';

interface QuickRequest {
  action: QuickAction;
  target: BulkModerationTarget;
}

const QUICK_TITLE: Record<QuickAction, string> = {
  warn: 'Предупредить игрока',
  kick: 'Кикнуть игрока',
  ban: 'Забанить игрока',
};

/** Подпись подтверждающей кнопки называет действие, а не отвечает «Да» (§5). */
const QUICK_CONFIRM: Record<QuickAction, string> = {
  warn: 'Предупредить',
  kick: 'Кик',
  ban: 'Забанить',
};

const QUICK_EXPLANATION: Record<QuickAction, string> = {
  warn: 'Игрок получит предупреждение в игре. Причина попадёт в его карточку.',
  kick: 'Игрок будет отключён от сервера и сможет вернуться сразу же.',
  ban: 'Игрок будет отключён и не сможет зайти до конца срока бана.',
};

const BAN_LENGTHS: ReadonlyArray<{ value: string; label: string; permanent: boolean }> = [
  { value: '1d', label: '1 день', permanent: false },
  { value: '3d', label: '3 дня', permanent: false },
  { value: '7d', label: '7 дней', permanent: false },
  { value: '30d', label: '30 дней', permanent: false },
  { value: '0', label: 'Навсегда', permanent: true },
];

/** Причины отказа из `results[].error` — те же, что показывает массовое окно. */
const TARGET_ERROR_LABEL: Record<string, string> = {
  player_not_found: 'Игрок не найден',
  target_identity_missing: 'Нет SteamID64 и EOS ID',
  target_offline: 'Игрок не в сети',
  rcon_failed: 'RCON не подтвердил команду',
  bulk_deadline_exceeded: 'Превышен лимит времени операции',
};

interface BulkResponse {
  applied: number;
  failed: number;
  results: Array<{
    player_id: string;
    status: 'applied' | 'failed';
    error?: string;
    detail?: string;
  }>;
}

/** Какие быстрые действия доступны обладателю этих `mod:*` ключей. */
function quickAbilities(permissions: readonly string[]) {
  return {
    warn: permissions.includes('mod:warn'),
    kick: permissions.includes('mod:kick'),
    ban: permissions.includes('mod:ban_temp') || permissions.includes('mod:ban_perm'),
  };
}

export function LivePlayers({
  serverId,
  canChat = false,
  canBan = false,
  modPermissions = [],
}: {
  serverId: string;
  /** Shows the per-squad "message" button. Hidden without the 'chat' squad permission. */
  canChat?: boolean;
  /** Shows the per-player «Забанить ник» button. Hidden without the 'ban' squad permission. */
  canBan?: boolean;
  /**
   * The caller's `mod:*` catalog keys from `GET /api/v1/me` (MOD-4, #61).
   * Multi-select and the bulk action bar stay hidden unless at least one of
   * them is present; the API enforces the same keys independently.
   */
  modPermissions?: readonly string[];
}) {
  const [roster, setRoster] = useState<RosterResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());
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

  const load = useCallback(async () => {
    try {
      const resp = await fetch(`/api/v1/servers/${serverId}/roster`, {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      setRoster((await resp.json()) as RosterResponse);
      setErr(null);
    } catch (loadError) {
      setErr((loadError as Error).message);
    }
  }, [serverId]);

  useEffect(() => {
    void load();
    const timer = setInterval(load, ROSTER_POLL_MS);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [load]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const onRoster = useCallback(
    (event: { data: { server_id: string } }) => {
      if (event.data.server_id === serverId) void load();
    },
    [serverId, load],
  );
  useLiveSubscription('rcon.roster', onRoster);

  const players = roster ? sortRoster(roster.players) : [];
  const groups = groupRosterBySquad(players);
  // Only roster entries resolved to a panel player can be bulk-targeted —
  // the API takes player uuids, not roster slots.
  const selectable: BulkModerationTarget[] = players.flatMap((player) =>
    player.player_id ? [{ playerId: player.player_id, name: player.name }] : [],
  );
  const bulkTargets = selectable.filter((target) => selected.has(target.playerId));
  const allSelected = selectable.length > 0 && bulkTargets.length === selectable.length;
  const abilities = quickAbilities(modPermissions);

  return (
    <Card padding="none" as="section">
      <CardHeader
        title="Игроки онлайн"
        count={roster ? players.length : undefined}
        description="Список обновляется каждые 30 секунд"
      />

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
        <Table ariaLabel="Игроки онлайн">
          <TableHead>
            <TableRow>
              {canBulk ? (
                <Th className="w-8">
                  <Checkbox
                    className="normal-case"
                    label={<span className="sr-only">Выделить всех</span>}
                    checked={allSelected}
                    onChange={() =>
                      setSelected(
                        allSelected
                          ? new Set()
                          : new Set(selectable.map((target) => target.playerId)),
                      )
                    }
                  />
                </Th>
              ) : null}
              <Th>Игрок</Th>
              <Th>SteamID64</Th>
              <Th>EOS ID</Th>
              <Th align="right">Команда</Th>
              <Th align="right">Отряд</Th>
              <Th align="right">На сервере</Th>
              <Th align="right">Действия</Th>
            </TableRow>
          </TableHead>
          <TableBody>
            {groups.map((group) => (
              <SquadGroupRows
                key={`${group.team_id}:${group.squad_id}`}
                group={group}
                now={now}
                serverId={serverId}
                canChat={canChat}
                canBan={canBan}
                canBulk={canBulk}
                abilities={abilities}
                selected={selected}
                onToggleSelected={toggleSelected}
                onSelectGroup={setSelected}
                onMessageSquad={setSquadTarget}
                onQuickAction={setQuick}
              />
            ))}
          </TableBody>
        </Table>
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

/**
 * Одиночное действие модерации из строки ростера (предупреждение, кик, бан).
 *
 * Ходит в тот же `POST /api/v1/moderation-actions/bulk`, что и массовое окно,
 * со списком из одной цели: у одиночного действия отдельного эндпоинта нет, а
 * заводить его ради строки таблицы незачем. Челленджа с количеством целей тут
 * нет — он охраняет массовый бан, где ошибка стоит десятков игроков; здесь
 * достаточно подтверждения и обязательной причины, которую всё равно требует
 * схема запроса.
 */
function QuickModerationDialog({
  serverId,
  request,
  permissions,
  onClose,
  onApplied,
}: {
  serverId: string;
  /** `null`, пока окно закрыто. */
  request: QuickRequest | null;
  permissions: readonly string[];
  onClose: () => void;
  onApplied: () => void;
}) {
  const [reason, setReason] = useState('');
  const [banLength, setBanLength] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reasonId = useId();
  const lengthId = useId();

  const canBanTemp = permissions.includes('mod:ban_temp');
  const canBanPerm = permissions.includes('mod:ban_perm');
  const banLengths = BAN_LENGTHS.filter((entry) => (entry.permanent ? canBanPerm : canBanTemp));

  const open = request !== null;
  // Причина и срок сбрасываются на каждое открытие: текст, набранный для
  // прошлого игрока, не должен уехать следующему.
  useEffect(() => {
    if (!open) return;
    setReason('');
    setBanLength(
      BAN_LENGTHS.filter((e) => (e.permanent ? canBanPerm : canBanTemp))[0]?.value ?? '0',
    );
    setError(null);
  }, [open, canBanPerm, canBanTemp]);

  if (!request) return null;

  const { action, target } = request;

  async function submit() {
    const trimmed = reason.trim();
    if (trimmed.length === 0) {
      setError('Укажите причину — она попадёт в карточку игрока и в журнал действий.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/v1/moderation-actions/bulk', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          server_id: serverId,
          action_type: action,
          player_ids: [target.playerId],
          reason: trimmed,
          ban_length: action === 'ban' ? banLength : '0',
          confirm_bulk: true,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      // Запрос не транзакционный: 200 приходит и тогда, когда единственная
      // цель не была задета, — причина лежит в `results[0].error`.
      const body = (await res.json()) as BulkResponse;
      const failure = body.results.find((row) => row.status === 'failed');
      if (failure) {
        setError(
          TARGET_ERROR_LABEL[failure.error ?? ''] ?? failure.error ?? 'Не удалось применить',
        );
        return;
      }
      onApplied();
    } catch (submitError) {
      setError((submitError as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AlertDialog
      open={open}
      onClose={onClose}
      title={QUICK_TITLE[action]}
      confirmLabel={QUICK_CONFIRM[action]}
      cancelLabel="Отмена"
      tone={action === 'ban' ? 'destructive' : 'default'}
      busy={busy}
      onConfirm={submit}
      body={
        <div className="space-y-3">
          <p>
            {target.name} — {QUICK_EXPLANATION[action]}
          </p>
          <FieldRow label="Причина" htmlFor={reasonId} required error={error}>
            <Textarea
              id={reasonId}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={300}
              rows={3}
              invalid={error !== null}
            />
          </FieldRow>
          {action === 'ban' ? (
            <FieldRow label="Срок бана" htmlFor={lengthId}>
              <Select
                id={lengthId}
                value={banLength}
                onChange={(event) => setBanLength(event.target.value)}
              >
                {banLengths.map((entry) => (
                  <option key={entry.value} value={entry.value}>
                    {entry.label}
                  </option>
                ))}
              </Select>
            </FieldRow>
          ) : null}
        </div>
      }
    />
  );
}

function SquadGroupRows({
  group,
  now,
  serverId,
  canChat,
  canBan,
  canBulk,
  abilities,
  selected,
  onToggleSelected,
  onSelectGroup,
  onMessageSquad,
  onQuickAction,
}: {
  group: SquadGroup;
  now: number;
  serverId: string;
  canChat: boolean;
  canBan: boolean;
  canBulk: boolean;
  abilities: ReturnType<typeof quickAbilities>;
  selected: ReadonlySet<string>;
  onToggleSelected: (playerId: string) => void;
  onSelectGroup: (update: (current: ReadonlySet<string>) => ReadonlySet<string>) => void;
  onMessageSquad: (target: SquadMessageTarget) => void;
  onQuickAction: (request: QuickRequest) => void;
}) {
  const messageable = canChat && group.team_id != null && group.squad_id != null;
  const label =
    group.squad_id != null
      ? `Команда ${teamLabel(group.team_id)} · Отряд ${squadLabel(group.squad_id)}`
      : `Команда ${teamLabel(group.team_id)} · Без отряда`;
  const colSpan = 7 + (canBulk ? 1 : 0);
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
            <span className="flex items-center gap-2">
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
              {label} <span className="font-normal text-ink-3">· {group.players.length}</span>
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
          now={now}
          serverId={serverId}
          canChat={canChat}
          canBan={canBan}
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

function RosterRow({
  player,
  now,
  serverId,
  canChat,
  canBan,
  canBulk,
  abilities,
  checked,
  onToggleSelected,
  onQuickAction,
}: {
  player: RosterPlayer;
  now: number;
  serverId: string;
  canChat: boolean;
  canBan: boolean;
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
        <span className="flex items-center gap-1.5">
          {player.is_leader ? (
            <span className="text-warn" title="Командир отряда">
              ★
            </span>
          ) : null}
          {player.player_id ? (
            <Link href={`/all-players/${player.player_id}`} className="text-accent">
              {player.name}
            </Link>
          ) : (
            <span>{player.name}</span>
          )}
        </span>
      </Td>
      <Td className="font-mono text-ink-2">{player.steam_id64 ?? '—'}</Td>
      <Td className="font-mono text-ink-3">
        <span title={player.eos_id}>{shortEos(player.eos_id)}</span>
      </Td>
      <Td numeric>{teamLabel(player.team_id)}</Td>
      <Td numeric>{squadLabel(player.squad_id)}</Td>
      <Td numeric>{formatTimeOnServer(player.first_seen_at, now)}</Td>
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
          <DirectMessageButton
            playerId={player.player_id}
            name={player.name}
            canChat={canChat}
            serverId={serverId}
            className="h-6 rounded-ctl px-1.5 text-2xs text-ink-2 transition-colors hover:bg-raised hover:text-ink"
          />
          <BanNickButton
            nick={player.name}
            canBan={canBan}
            className="h-6 rounded-ctl px-1.5 text-2xs text-ink-2 transition-colors hover:bg-crit/15 hover:text-crit"
          />
          {player.player_id ? (
            <ButtonLink
              href={`/all-players/${player.player_id}`}
              variant="ghost"
              size="sm"
              aria-label={`Досье: ${player.name}`}
            >
              Досье
            </ButtonLink>
          ) : null}
        </div>
      </Td>
    </TableRow>
  );
}
