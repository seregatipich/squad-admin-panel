'use client';

import { use, useCallback, useEffect, useState } from 'react';

import { BannedNameRuleModal } from '@/components/BannedNameRuleModal';
import { DirectMessageButton } from '@/components/DirectMessageModal';
import { DossierSection } from '@/components/DossierSection';
import { PlayerMarks } from '@/components/PlayerMarks';
import { RecentMatchesSection } from '@/components/RecentMatchesSection';
import {
  Button,
  ButtonLink,
  CopyIcon,
  DateTime,
  GroupedList,
  GroupedRow,
  IconButton,
  InlineBanner,
  PageContainer,
  PageHeader,
  Skeleton,
} from '@/components/ui';
import { useIntlLocale } from '@/i18n/LocaleProvider';
import { useApiResource } from '@/lib/use-polled-resource';
import { isUuid } from '@/lib/uuid';
import { AltsSection } from './AltsSection';
import { BonusSection } from './BonusSection';
import { ChatHistorySection } from './ChatHistorySection';
import { ClanWidget } from './ClanWidget';
import { DiscordLinkSection } from './DiscordLinkSection';
import { EvidenceSection } from './EvidenceSection';
import { ExternalBansSection } from './ExternalBansSection';
import { IssueLinksSection } from './IssueLinksSection';
import { LocationSection } from './LocationSection';
import { ModerationHistorySection } from './ModerationHistorySection';
import { NameHistorySection } from './NameHistorySection';
import { NickBanSection } from './NickBanSection';
import { NotesSection } from './NotesSection';
import { PanelAccessSection } from './PanelAccessSection';
import { PlayerTeamkillsSection } from './PlayerTeamkillsSection';
import { PlaysWithSection } from './PlaysWithSection';
import { PresenceSection } from './PresenceSection';
import type { Me, PlayerResponse } from './player-detail';
import { fmtDuration } from './presence';
import { ReportPlayerSection } from './ReportPlayerSection';
import { ReportsSection } from './ReportsSection';
import { SeedContributionSection } from './SeedContributionSection';
import { SteamProfileSection } from './SteamProfileSection';
import { SubscriptionGrantSection } from './SubscriptionGrantSection';
import { VotesSection } from './VotesSection';
import { WhitelistQuickAction } from './WhitelistQuickAction';

const BACK_TO_LIST = { backHref: '/all-players', backLabel: 'К списку игроков' } as const;

export default function PlayerDetail({ params }: { params: Promise<{ id: string }> }) {
  const locale = useIntlLocale();
  const { id: playerId } = use(params);
  // The route segment arrives URL-decoded and every section builds API paths
  // from it; anything but a UUID is refused before a single request (#472).
  const validPlayerId = isUuid(playerId);
  const {
    data,
    errorMessage: err,
    refresh: refreshPlayer,
  } = useApiResource<PlayerResponse>(validPlayerId ? `/api/v1/players/${playerId}` : null);
  const { data: meData, refresh: refreshMe } = useApiResource<Me>(
    validPlayerId ? '/api/v1/me' : null,
  );
  const me = meData ?? null;
  const [banTarget, setBanTarget] = useState<string | null>(null);
  const [nickBanRefreshKey, setNickBanRefreshKey] = useState(0);
  // WhitelistQuickAction and PanelAccessSection each show the same player role
  // from their own independent fetch; bumping this after either one mutates
  // the role makes both refetch it, so neither shows a stale role/whitelist
  // status after the other one changes it (#477).
  const [roleRefreshKey, setRoleRefreshKey] = useState(0);
  const onRoleChanged = useCallback(() => setRoleRefreshKey((key) => key + 1), []);
  const [evidenceRefreshKey, setEvidenceRefreshKey] = useState(0);
  const [eosCopied, setEosCopied] = useState(false);

  useEffect(() => {
    if (!eosCopied) return;
    const timer = setTimeout(() => setEosCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [eosCopied]);

  /** «Повторить» повторяет ровно те же два запроса, что и загрузка при открытии. */
  const load = () => {
    void refreshPlayer();
    void refreshMe();
  };

  if (!validPlayerId) {
    return (
      <PageContainer width="wide">
        <PageHeader {...BACK_TO_LIST} title="Карточка игрока" />
        <InlineBanner
          tone="crit"
          title="Некорректный идентификатор игрока"
          description="Ссылка повреждена: откройте игрока из списка."
        />
      </PageContainer>
    );
  }

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
  const canManageEconomy = me?.can_manage_economy ?? false;
  const canViewServers = me?.permissions.includes('server:view') ?? false;

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
              // biome-ignore lint/performance/noImgElement: the image optimizer is disabled (next.config images.unoptimized), so next/image would add nothing for this panel-streamed image
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

      <WhitelistQuickAction
        playerId={playerId}
        canEdit={canEditWhitelist}
        canManageRoles={canManageRoles}
        roleRefreshKey={roleRefreshKey}
        onRoleChanged={onRoleChanged}
      />

      <ReportPlayerSection playerId={playerId} canViewServers={canViewServers} />

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

      <PanelAccessSection
        playerId={playerId}
        canManage={canManageRoles}
        roleRefreshKey={roleRefreshKey}
        onRoleChanged={onRoleChanged}
      />

      <DiscordLinkSection playerId={playerId} me={me} />

      <BonusSection playerId={playerId} canManage={canManageEconomy} canAssign={canManageRoles} />

      <SubscriptionGrantSection playerId={playerId} />

      <SeedContributionSection playerId={playerId} />

      <PresenceSection playerId={playerId} />

      <NotesSection playerId={playerId} me={me} />

      <DossierSection playerId={playerId} />

      <RecentMatchesSection playerId={playerId} />

      <PlayerTeamkillsSection playerId={playerId} />

      <ReportsSection playerId={playerId} />

      <ModerationHistorySection
        playerId={playerId}
        viewerPlayerId={me?.player_id ?? null}
        onEvidenceDetached={() => setEvidenceRefreshKey((key) => key + 1)}
      />
      <IssueLinksSection playerId={playerId} />

      <EvidenceSection playerId={playerId} refreshKey={evidenceRefreshKey} />

      <ExternalBansSection playerId={playerId} canBan={canBan} />

      <VotesSection playerId={playerId} />

      <ChatHistorySection playerId={playerId} />

      <NameHistorySection names={names} canBan={canBan} onBanName={setBanTarget} />

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

function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] ?? '')
    .join('')
    .toUpperCase();
}
