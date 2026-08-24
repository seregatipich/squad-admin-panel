'use client';

import type { RoleColor } from '@squad/shared-config/role-colors';

import { use, useCallback, useEffect, useId, useState } from 'react';

import { BannedNameRuleModal } from '@/components/BannedNameRuleModal';
import { DirectMessageButton } from '@/components/DirectMessageModal';
import { PlayerMarks } from '@/components/PlayerMarks';
import { RoleColorDot } from '@/components/RoleColorDot';
import { RoleExpiryDateField } from '@/components/RoleExpiryDateField';
import {
  AlertDialog,
  Badge,
  Button,
  ButtonLink,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  CopyIcon,
  DateTime,
  EmptyState,
  FieldRow,
  GroupedList,
  GroupedRow,
  IconButton,
  InlineBanner,
  PageContainer,
  PageHeader,
  Select,
  Skeleton,
  Table,
  TableBody,
  TableHead,
  TableRow,
  Td,
  Textarea,
  Th,
} from '@/components/ui';
import { useIntlLocale } from '@/i18n/LocaleProvider';
import {
  buildRoleAssignPayload,
  DEFAULT_VIP_EXPIRY_WINDOWS_DAYS,
  formatRoleExpiryLabel,
  isRoleExpirySoon,
  toRoleExpiryDateValue,
} from '@/lib/role-expiry';
import { AltsSection } from './AltsSection';
import { BonusSection } from './BonusSection';
import { ChatHistorySection } from './ChatHistorySection';
import { ClanWidget, type PlayerClan } from './ClanWidget';
import { DiscordLinkSection } from './DiscordLinkSection';
import { DossierSection } from './DossierSection';
import { EvidenceSection } from './EvidenceSection';
import { ExternalBansSection } from './ExternalBansSection';
import { GeoAnomaliesSection } from './GeoAnomaliesSection';
import { IssueLinksSection } from './IssueLinksSection';
import { ModerationHistorySection } from './ModerationHistorySection';
import { NickBanSection } from './NickBanSection';
import { NotesSection } from './NotesSection';
import { PlayerTeamkillsSection } from './PlayerTeamkillsSection';
import { PlaysWithSection } from './PlaysWithSection';
import { PresenceSection } from './PresenceSection';
import { RecentMatchesSection } from './RecentMatchesSection';
import { ReportPlayerSection } from './ReportPlayerSection';
import { ReportsSection } from './ReportsSection';
import { SeedContributionSection } from './SeedContributionSection';
import { SteamProfileSection, type SteamSnapshot } from './SteamProfileSection';
import { SubscriptionGrantSection } from './SubscriptionGrantSection';
import { VotesSection } from './VotesSection';

interface Player extends SteamSnapshot {
  id: string;
  steam_id64: string | null;
  canonical_name: string;
  eos_id: string | null;
  first_seen_at: string;
  last_seen_at: string;
  total_time_played_seconds: number;
}

interface NameHistory {
  name: string;
  name_normalized: string;
  first_seen_at: string;
  last_seen_at: string;
  observation_count: number;
}

interface IpHistory {
  ip: string;
  country_code: string | null;
  country_name: string | null;
  region: string | null;
  city: string | null;
  timezone_offset: string | null;
  latitude: number | null;
  longitude: number | null;
  first_seen_at: string;
  last_seen_at: string;
  observation_count: number;
}

interface CountryLocation {
  country_code: string;
  country_name: string | null;
  last_seen_at: string;
}

interface PlayerResponse {
  player: Player;
  clan: PlayerClan | null;
  names: NameHistory[];
  ips: IpHistory[];
  locations: CountryLocation[];
  ips_visible: boolean;
  geo_configured: boolean;
}

interface SingleRole {
  id: string;
  name: string;
  color: RoleColor;
  is_system_role: boolean;
  role_expires_at: string | null;
  role_comment: string | null;
}

interface Me {
  player_id: string;
  permissions: string[];
  squad_permissions?: string[];
}

const BACK_TO_LIST = { backHref: '/all-players', backLabel: 'К списку игроков' } as const;

export default function PlayerDetail({ params }: { params: Promise<{ id: string }> }) {
  const locale = useIntlLocale();
  const { id: playerId } = use(params);
  const [data, setData] = useState<PlayerResponse | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [banTarget, setBanTarget] = useState<string | null>(null);
  const [nickBanRefreshKey, setNickBanRefreshKey] = useState(0);
  const [eosCopied, setEosCopied] = useState(false);

  useEffect(() => {
    if (!eosCopied) return;
    const timer = setTimeout(() => setEosCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [eosCopied]);

  /**
   * Загрузка карточки. Та же функция служит и эффектом монтирования, и
   * обработчиком «Повторить», поэтому повторная попытка повторяет ровно те же
   * два запроса.
   */
  const load = useCallback(() => {
    setErr(null);
    fetch(`/api/v1/players/${playerId}`, { credentials: 'include', cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setData)
      .catch((e) => setErr((e as Error).message));
    fetch('/api/v1/me', { credentials: 'include', cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => setMe(j as Me | null))
      .catch(() => {});
  }, [playerId]);

  useEffect(() => {
    load();
  }, [load]);

  if (err) {
    return (
      <PageContainer width="wide">
        <PageHeader {...BACK_TO_LIST} title="Карточка игрока" />
        <InlineBanner
          tone="crit"
          title="Не удалось загрузить карточку игрока"
          description={err}
          action={
            <Button size="sm" onClick={load}>
              Повторить
            </Button>
          }
        />
      </PageContainer>
    );
  }

  if (!data) {
    return (
      <PageContainer width="wide">
        <PageHeader {...BACK_TO_LIST} title="Карточка игрока" />
        <Skeleton variant="card" count={3} label="Загрузка карточки игрока" />
      </PageContainer>
    );
  }

  const { player, clan, names, ips, locations, ips_visible, geo_configured } = data;
  const canManageRoles = me?.permissions.includes('user:manage_roles') ?? false;
  const canEditWhitelist = me?.permissions.includes('whitelist:edit') ?? false;
  const canBan = me?.squad_permissions?.includes('ban') ?? false;
  const canChat = me?.squad_permissions?.includes('chat') ?? false;
  const canViewIps = me?.permissions.includes('player:view_ips') ?? false;
  const canAccessPanel = me?.permissions.includes('player:view') ?? false;

  async function copyEosId() {
    if (!player.eos_id) return;
    try {
      await navigator.clipboard.writeText(player.eos_id);
      setEosCopied(true);
    } catch {
      setEosCopied(false);
    }
  }

  return (
    <PageContainer width="wide">
      <PageHeader
        {...BACK_TO_LIST}
        title={
          <span className="flex items-center gap-3">
            {player.avatar_url ? (
              // INT-1 (#76): the manual route or periodic worker replaces the
              // initials placeholder once a Steam avatar has been stored.
              // Аватар декоративен — имя игрока стоит рядом в том же заголовке.
              <img
                data-testid="player-avatar"
                src={player.avatar_url}
                alt=""
                className="h-9 w-9 shrink-0 rounded-full bg-raised object-cover"
              />
            ) : (
              <span
                data-testid="player-avatar"
                aria-hidden="true"
                className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-raised text-[13px] font-semibold text-ink-2"
              >
                {initials(player.canonical_name)}
              </span>
            )}
            {player.canonical_name}
          </span>
        }
        status={<ClanWidget clan={clan} />}
        actions={
          <>
            <DirectMessageButton
              playerId={playerId}
              name={player.canonical_name}
              canChat={canChat}
            />
            <ButtonLink href={`/all-players/${playerId}/compare`} size="sm">
              Сравнить онлайн
            </ButtonLink>
          </>
        }
      />

      <NickBanSection nick={player.canonical_name} refreshKey={nickBanRefreshKey} />

      <PlayerMarks playerId={playerId} />

      <WhitelistQuickAction playerId={playerId} canEdit={canEditWhitelist} />

      <ReportPlayerSection playerId={playerId} />

      <GroupedList title="Профиль">
        <GroupedRow
          label="SteamID64"
          control={
            player.steam_id64 ? (
              <a
                href={`https://steamcommunity.com/profiles/${player.steam_id64}`}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-accent no-underline hover:brightness-110"
              >
                {player.steam_id64}
              </a>
            ) : (
              <span className="text-ink-3">—</span>
            )
          }
        />
        <GroupedRow
          label="EOS ID"
          control={
            player.eos_id != null ? (
              <span className="inline-flex flex-wrap items-center gap-2">
                <span className="font-mono">{player.eos_id}</span>
                <IconButton icon={<CopyIcon />} label="Скопировать EOS ID" onClick={copyEosId} />
                {eosCopied ? <span className="text-xs text-good">скопировано</span> : null}
              </span>
            ) : (
              <span className="text-ink-3">—</span>
            )
          }
        />
        <GroupedRow
          label="Впервые замечен"
          control={<DateTime value={player.first_seen_at} locale={locale} />}
        />
        <GroupedRow
          label="Был(а)"
          control={<DateTime value={player.last_seen_at} locale={locale} />}
        />
        <GroupedRow
          label="Наиграно"
          control={
            <span className="font-mono tabular-nums">
              {fmtDuration(player.total_time_played_seconds)}
            </span>
          }
        />
      </GroupedList>

      <SteamProfileSection playerId={playerId} steamId64={player.steam_id64} snapshot={player} />

      <PanelAccessSection playerId={playerId} canManage={canManageRoles} />

      <DiscordLinkSection playerId={playerId} me={me} />

      <BonusSection playerId={playerId} />

      <SubscriptionGrantSection playerId={playerId} />

      <SeedContributionSection playerId={playerId} />

      <PresenceSection playerId={playerId} />

      <NotesSection playerId={playerId} me={me} />

      <DossierSection playerId={playerId} />

      <RecentMatchesSection playerId={playerId} />

      <PlayerTeamkillsSection playerId={playerId} />

      <ReportsSection playerId={playerId} />

      <ModerationHistorySection playerId={playerId} viewerPlayerId={me?.player_id ?? null} />
      <IssueLinksSection playerId={playerId} />

      <EvidenceSection playerId={playerId} />

      <ExternalBansSection playerId={playerId} canBan={canBan} />

      <VotesSection playerId={playerId} />

      <ChatHistorySection playerId={playerId} />

      <Card as="section" padding="none">
        <CardHeader title="История ников" count={names.length > 0 ? names.length : undefined} />
        {names.length === 0 ? (
          <EmptyState
            title="Только основной ник"
            description="Панель не видела этого игрока ни под каким другим ником."
          />
        ) : (
          <Table ariaLabel="История ников игрока">
            <TableHead sticky={false}>
              <tr>
                <Th>Ник</Th>
                <Th align="right">Замечен, раз</Th>
                <Th>Первый раз</Th>
                <Th>Последний раз</Th>
                {canBan ? <Th>Действие</Th> : null}
              </tr>
            </TableHead>
            <TableBody>
              {names.map((n) => (
                <TableRow key={n.name_normalized}>
                  <Td className="font-medium">{n.name}</Td>
                  <Td numeric>{n.observation_count}</Td>
                  <Td className="text-xs text-ink-3">
                    <DateTime value={n.first_seen_at} locale={locale} />
                  </Td>
                  <Td className="text-xs text-ink-3">
                    <DateTime value={n.last_seen_at} locale={locale} />
                  </Td>
                  {canBan ? (
                    <Td>
                      <Button size="sm" onClick={() => setBanTarget(n.name)}>
                        Забанить ник
                      </Button>
                    </Td>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <LocationSection
        playerId={playerId}
        ips={ips}
        locations={locations}
        ipsVisible={ips_visible}
        geoConfigured={geo_configured}
      />

      {canViewIps ? <AltsSection playerId={playerId} /> : null}

      {canAccessPanel ? <PlaysWithSection playerId={playerId} /> : null}

      <BannedNameRuleModal
        open={banTarget !== null}
        initial={{ pattern: banTarget ?? '', match_type: 'exact' }}
        onClose={() => setBanTarget(null)}
        onSaved={() => {
          setBanTarget(null);
          setNickBanRefreshKey((key) => key + 1);
        }}
      />
    </PageContainer>
  );
}

interface WhitelistSettings {
  whitelist_role_id: string | null;
  whitelist_role_name: string | null;
}

/**
 * One-click "add to / remove from whitelist" action (WL-1, #65). Assigning or
 * removing the whitelist role is idempotent server-side, so this component
 * only needs to know the configured whitelist role and whether the current
 * player already holds it.
 */
function WhitelistQuickAction({ playerId, canEdit }: { playerId: string; canEdit: boolean }) {
  const [settings, setSettings] = useState<WhitelistSettings | null>(null);
  const [current, setCurrent] = useState<SingleRole | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const reload = useCallback(async () => {
    const [settingsRes, roleRes] = await Promise.all([
      fetch('/api/v1/whitelist/settings', { credentials: 'include', cache: 'no-store' }),
      fetch(`/api/v1/players/${playerId}/role`, { credentials: 'include', cache: 'no-store' }),
    ]);
    if (settingsRes.ok) setSettings((await settingsRes.json()) as WhitelistSettings);
    if (roleRes.ok) {
      const body = (await roleRes.json()) as { role: SingleRole | null };
      setCurrent(body.role);
    }
  }, [playerId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (!settings?.whitelist_role_id) return null;

  const isWhitelisted = current?.id === settings.whitelist_role_id;

  async function toggle() {
    setBusy(true);
    setMsg(null);
    try {
      const r = isWhitelisted
        ? await fetch(`/api/v1/whitelist/members/${playerId}`, {
            method: 'DELETE',
            credentials: 'include',
          })
        : await fetch('/api/v1/whitelist/members', {
            method: 'POST',
            credentials: 'include',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ player_id: playerId }),
          });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await reload();
      setMsg({ kind: 'ok', text: isWhitelisted ? 'Убран из whitelist.' : 'Добавлен в whitelist.' });
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card as="section" padding="none">
      <CardHeader
        title="Whitelist"
        description={isWhitelisted ? 'Игрок в whitelist.' : 'Игрок не в whitelist.'}
        actions={
          canEdit ? (
            <Button size="sm" loading={busy} onClick={() => void toggle()}>
              {isWhitelisted ? 'Убрать из whitelist' : 'В whitelist'}
            </Button>
          ) : undefined
        }
      />
      {msg ? (
        <CardBody>
          <InlineBanner
            tone={msg.kind === 'ok' ? 'good' : 'crit'}
            title={msg.text}
            onDismiss={() => setMsg(null)}
            dismissLabel="Скрыть сообщение"
          />
        </CardBody>
      ) : null}
    </Card>
  );
}

function PanelAccessSection({ playerId, canManage }: { playerId: string; canManage: boolean }) {
  const [current, setCurrent] = useState<SingleRole | null>(null);
  const [editing, setEditing] = useState(false);
  const [allRoles, setAllRoles] = useState<SingleRole[]>([]);
  const [picked, setPicked] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const commentHintId = useId();

  const reload = useCallback(async () => {
    const [rRes, listRes] = await Promise.all([
      fetch(`/api/v1/players/${playerId}/role`, { credentials: 'include', cache: 'no-store' }),
      // Only managers need the full role list; viewers don't query it.
      canManage
        ? fetch('/api/v1/roles', { credentials: 'include', cache: 'no-store' })
        : Promise.resolve(null),
    ]);
    if (rRes.ok) {
      const body = (await rRes.json()) as { role: SingleRole | null };
      setCurrent(body.role);
    }
    if (listRes?.ok) setAllRoles((await listRes.json()) as SingleRole[]);
  }, [playerId, canManage]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!editing) return;
    setExpiresAt(toRoleExpiryDateValue(current?.role_expires_at));
    setComment(current?.role_comment ?? '');
  }, [editing, current?.role_expires_at, current?.role_comment]);

  // 2.6.4 — dropdown excludes Owner and the player's current role; the
  // backend also rejects Owner assignment with 403 owner_assignment_forbidden.
  const assignableRoles = allRoles.filter(
    (r) => !(r.is_system_role && r.name === 'Owner') && r.id !== current?.id,
  );

  async function save(roleId: string | null) {
    setBusy(true);
    setMsg(null);
    try {
      const r =
        roleId === null
          ? await fetch(`/api/v1/players/${playerId}/role`, {
              method: 'DELETE',
              credentials: 'include',
            })
          : await fetch(`/api/v1/players/${playerId}/role`, {
              method: 'PUT',
              credentials: 'include',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(buildRoleAssignPayload(roleId, expiresAt, comment)),
            });
      if (r.status === 409) {
        setMsg({
          kind: 'err',
          text: 'Вы единственный Owner. Сначала выдайте роль Owner другому пользователю.',
        });
        return;
      }
      if (r.status === 403) {
        setMsg({ kind: 'err', text: 'Нельзя выдать роль Owner через UI.' });
        return;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await reload();
      setEditing(false);
      setMsg({ kind: 'ok', text: 'Готово.' });
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const isOwner = current?.is_system_role === true && current.name === 'Owner';

  return (
    <Card as="section" padding="none">
      <CardHeader
        title="Роль"
        actions={
          canManage ? (
            <>
              {!isOwner ? (
                <Button size="sm" onClick={() => setEditing(true)}>
                  Выдать роль
                </Button>
              ) : null}
              {current ? (
                <Button size="sm" disabled={busy} onClick={() => setRemoveOpen(true)}>
                  Снять роль
                </Button>
              ) : null}
            </>
          ) : (
            <span className="text-xs text-ink-3">только просмотр</span>
          )
        }
      />

      <CardBody className="space-y-3">
        {msg ? (
          <InlineBanner
            tone={msg.kind === 'ok' ? 'good' : 'crit'}
            title={msg.text}
            onDismiss={() => setMsg(null)}
            dismissLabel="Скрыть сообщение"
          />
        ) : null}

        {!editing ? (
          current ? (
            <div className="space-y-1">
              <span className="inline-flex items-center gap-2">
                <RoleColorDot color={current.color} />
                <span className="font-medium">{current.name}</span>
                {isOwner ? (
                  <Badge tone="crit" size="sm">
                    системная
                  </Badge>
                ) : null}
              </span>
              <span className="block text-xs text-ink-3">
                {formatRoleExpiryLabel(current.role_expires_at)}
                {current.role_comment ? ` · ${current.role_comment}` : ''}
              </span>
              {isRoleExpirySoon(current.role_expires_at, DEFAULT_VIP_EXPIRY_WINDOWS_DAYS) ? (
                <Badge tone="warn" size="sm">
                  истекает
                </Badge>
              ) : null}
            </div>
          ) : (
            <p className="text-[13px] text-ink-3">Роль не выдана.</p>
          )
        ) : (
          <div className="space-y-3">
            <div className="grid gap-3 md:grid-cols-[1fr_320px]">
              <FieldRow label="Новая роль" htmlFor={`role-select-${playerId}`}>
                <Select
                  id={`role-select-${playerId}`}
                  value={picked}
                  onChange={(e) => setPicked(e.target.value)}
                >
                  <option value="">— выберите —</option>
                  {assignableRoles.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </Select>
              </FieldRow>

              <FieldRow label="Срок действия" htmlFor={`role-expiry-${playerId}`}>
                <RoleExpiryDateField
                  id={`role-expiry-${playerId}`}
                  value={expiresAt}
                  onChange={setExpiresAt}
                />
              </FieldRow>
            </div>

            <FieldRow
              label="Комментарий"
              htmlFor={`role-comment-${playerId}`}
              hint={
                // Идентификатор нужен, чтобы пояснение читалось скринридером как
                // описание поля: `FieldRow` связывает с полем только текст ошибки.
                <span id={commentHintId}>
                  Необязательно. Причина выдачи видна другим администраторам в карточке игрока и
                  списках.
                </span>
              }
            >
              <Textarea
                id={`role-comment-${playerId}`}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                maxLength={512}
                rows={2}
                aria-describedby={commentHintId}
                placeholder="Например: VIP по заявке"
                className="resize-none"
              />
            </FieldRow>
          </div>
        )}
      </CardBody>

      {editing ? (
        <CardFooter>
          <Button
            variant="secondary"
            onClick={() => {
              setEditing(false);
              setPicked('');
            }}
            disabled={busy}
          >
            Отмена
          </Button>
          <Button
            variant="primary"
            onClick={() => picked && save(picked)}
            disabled={!picked}
            loading={busy}
          >
            Сохранить
          </Button>
        </CardFooter>
      ) : null}

      {current ? (
        <AlertDialog
          open={removeOpen}
          onClose={() => setRemoveOpen(false)}
          title="Снять роль"
          body={`Роль «${current.name}» будет снята с этого игрока, вместе с доступом, который она давала. Роль можно выдать заново.`}
          confirmLabel="Снять роль"
          cancelLabel="Отмена"
          tone="destructive"
          busy={busy}
          onConfirm={async () => {
            await save(null);
            setRemoveOpen(false);
          }}
        />
      ) : null}
    </Card>
  );
}

function flagEmoji(countryCode: string | null): string {
  if (!countryCode || countryCode.length !== 2) return '🏳️';
  const base = 0x1f1e6;
  const upper = countryCode.toUpperCase();
  const first = upper.charCodeAt(0) - 65;
  const second = upper.charCodeAt(1) - 65;
  if (first < 0 || first > 25 || second < 0 || second > 25) return '🏳️';
  return String.fromCodePoint(base + first) + String.fromCodePoint(base + second);
}

function locationLabel(ip: IpHistory): string {
  const parts = [ip.country_name ?? ip.country_code].filter(Boolean) as string[];
  const detail = [ip.region, ip.city].filter(Boolean) as string[];
  const head = parts.join('');
  const tail = detail.length > 0 ? ` − ${detail.join(' / ')}` : '';
  const tz = ip.timezone_offset ? ` (${ip.timezone_offset})` : '';
  return `${head}${tail}${tz}`;
}

function LocationSection({
  playerId,
  ips,
  locations,
  ipsVisible,
  geoConfigured,
}: {
  playerId: string;
  ips: IpHistory[];
  locations: CountryLocation[];
  ipsVisible: boolean;
  geoConfigured: boolean;
}) {
  const locale = useIntlLocale();
  if (!ipsVisible) {
    return (
      <Card as="section" padding="none">
        <CardHeader
          title="Локация"
          description="IP и точная локация доступны только пользователям с доступом к панели."
        />
        {locations.length === 0 ? (
          <EmptyState
            title="Нет данных о локации"
            description="Панель не определила ни одной страны для этого игрока."
          />
        ) : (
          <CardBody>
            <ul className="space-y-1 text-[13px]">
              {locations.map((loc) => (
                <li key={loc.country_code} className="flex items-center gap-2">
                  <span aria-hidden="true">{flagEmoji(loc.country_code)}</span>
                  <span>{loc.country_name ?? loc.country_code}</span>
                </li>
              ))}
            </ul>
          </CardBody>
        )}
      </Card>
    );
  }

  const current = ips[0] ?? null;
  const others = ips.slice(1);

  return (
    <Card as="section" padding="none">
      <CardHeader title="Локация" count={ips.length > 0 ? ips.length : undefined} />

      <CardBody className="space-y-6">
        {current === null ? (
          <EmptyState
            title="Локаций пока нет"
            description="Панель не записала ни одного подключения этого игрока."
          />
        ) : (
          <div className="space-y-1">
            <p className="text-2xs uppercase tracking-[0.06em] text-ink-3">Текущая</p>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
              <span aria-hidden="true" className="text-lg leading-none">
                {flagEmoji(current.country_code)}
              </span>
              {current.country_code ? (
                <span className="font-medium">{locationLabel(current)}</span>
              ) : (
                <span className="text-warn">
                  гео недоступно
                  {geoConfigured ? '' : ': добавьте MaxMind ключ в настройках'}
                </span>
              )}
              <span className="font-mono text-ink-2">{current.ip}</span>
              <DateTime value={current.last_seen_at} locale={locale} className="text-ink-3" />
              <span className="font-mono tabular-nums text-ink-3">
                ×{current.observation_count}
              </span>
            </div>
          </div>
        )}

        {others.length > 0 ? (
          <div className="space-y-2">
            <p className="text-2xs uppercase tracking-[0.06em] text-ink-3">Другие локации</p>
            <Table ariaLabel="Другие локации игрока">
              <TableHead sticky={false}>
                <tr>
                  <Th>Локация</Th>
                  <Th>IP</Th>
                  <Th align="right">Заходов</Th>
                  <Th>Последний раз</Th>
                </tr>
              </TableHead>
              <TableBody>
                {others.map((ip) => (
                  <TableRow key={ip.ip}>
                    <Td>
                      <span aria-hidden="true" className="mr-1">
                        {flagEmoji(ip.country_code)}
                      </span>
                      {ip.country_code ? (
                        locationLabel(ip)
                      ) : (
                        <span className="text-warn">
                          гео недоступно
                          {geoConfigured ? '' : ': добавьте MaxMind ключ'}
                        </span>
                      )}
                    </Td>
                    <Td className="font-mono">{ip.ip}</Td>
                    <Td numeric>{ip.observation_count}</Td>
                    <Td className="text-xs text-ink-3">
                      <DateTime value={ip.last_seen_at} locale={locale} />
                    </Td>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : null}

        <GeoAnomaliesSection playerId={playerId} />
      </CardBody>
    </Card>
  );
}

function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] ?? '')
    .join('')
    .toUpperCase();
}

function fmtDuration(seconds: number): string {
  if (!seconds) return '0m';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}
