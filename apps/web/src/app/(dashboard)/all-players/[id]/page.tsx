'use client';

import type { RoleColor } from '@squad/shared-config/role-colors';

import Link from 'next/link';
import { use, useCallback, useEffect, useState } from 'react';

import { BannedNameRuleModal } from '@/components/BannedNameRuleModal';
import { DirectMessageButton } from '@/components/DirectMessageModal';
import { PlayerMarks } from '@/components/PlayerMarks';
import { RoleColorDot } from '@/components/RoleColorDot';
import {
  buildRoleAssignPayload,
  DEFAULT_VIP_EXPIRY_WINDOWS_DAYS,
  formatRoleExpiryLabel,
  isRoleExpirySoon,
  toDatetimeLocalValue,
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

export default function PlayerDetail({ params }: { params: Promise<{ id: string }> }) {
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

  useEffect(() => {
    fetch(`/api/v1/players/${playerId}`, { credentials: 'include', cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setData)
      .catch((e) => setErr((e as Error).message));
    fetch('/api/v1/me', { credentials: 'include', cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => setMe(j as Me | null))
      .catch(() => {});
  }, [playerId]);

  if (err) {
    return (
      <div>
        <Link href="/all-players" className="text-sky-400 text-xs">
          ← игроки
        </Link>
        <div className="mt-3 rounded border border-red-900 bg-red-950 p-3 text-sm">
          Ошибка: {err}
        </div>
      </div>
    );
  }
  if (!data) return <div className="text-neutral-500">Загрузка…</div>;

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
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <Link href="/all-players" className="text-sky-400 hover:text-sky-300 text-xs font-mono">
          ← игроки
        </Link>
        {player.avatar_url ? (
          // INT-1 (#76): the manual route or periodic worker replaces the
          // initials placeholder once a Steam avatar has been stored.
          <img
            data-testid="player-avatar"
            src={player.avatar_url}
            alt={`Аватар ${player.canonical_name}`}
            className="h-10 w-10 shrink-0 rounded-full bg-neutral-800 object-cover"
          />
        ) : (
          <div
            data-testid="player-avatar"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-neutral-800 text-sm font-semibold text-neutral-300"
          >
            {initials(player.canonical_name)}
          </div>
        )}
        <h1 className="text-2xl font-semibold">{player.canonical_name}</h1>
        <ClanWidget clan={clan} />
        <DirectMessageButton playerId={playerId} name={player.canonical_name} canChat={canChat} />
      </div>

      <NickBanSection nick={player.canonical_name} refreshKey={nickBanRefreshKey} />

      <PlayerMarks playerId={playerId} />

      <WhitelistQuickAction playerId={playerId} canEdit={canEditWhitelist} />

      <ReportPlayerSection playerId={playerId} />

      <section className="rounded border border-neutral-800 bg-neutral-950 p-4 space-y-2">
        <h2 className="text-xs uppercase tracking-widest text-neutral-400">Профиль</h2>
        <dl className="grid grid-cols-[160px_1fr] gap-y-1 text-sm">
          <dt className="text-neutral-500">SteamID64</dt>
          <dd className="font-mono">
            {player.steam_id64 ? (
              <a
                href={`https://steamcommunity.com/profiles/${player.steam_id64}`}
                target="_blank"
                rel="noreferrer"
                className="text-sky-400 hover:text-sky-300"
              >
                {player.steam_id64}
              </a>
            ) : (
              <span className="text-neutral-600">—</span>
            )}
          </dd>
          <dt className="text-neutral-500">EOS ID</dt>
          <dd className="font-mono">
            {player.eos_id != null ? (
              <span className="inline-flex flex-wrap items-center gap-2">
                {player.eos_id}
                <button
                  type="button"
                  onClick={copyEosId}
                  aria-label="Скопировать EOS ID"
                  className="text-sky-400 hover:text-sky-300 text-xs"
                >
                  копировать
                </button>
                {eosCopied && <span className="text-emerald-400 text-xs">скопировано</span>}
              </span>
            ) : (
              '—'
            )}
          </dd>
          <dt className="text-neutral-500">First seen</dt>
          <dd>{new Date(player.first_seen_at).toLocaleString()}</dd>
          <dt className="text-neutral-500">Last seen</dt>
          <dd>{new Date(player.last_seen_at).toLocaleString()}</dd>
          <dt className="text-neutral-500">Total playtime</dt>
          <dd className="font-mono">{fmtDuration(player.total_time_played_seconds)}</dd>
        </dl>
      </section>

      <SteamProfileSection playerId={playerId} steamId64={player.steam_id64} snapshot={player} />

      <PanelAccessSection playerId={playerId} canManage={canManageRoles} />

      <DiscordLinkSection playerId={playerId} me={me} />

      <BonusSection playerId={playerId} />

      <SubscriptionGrantSection playerId={playerId} />

      <div className="flex justify-end">
        <Link
          href={`/all-players/${playerId}/compare`}
          className="text-sky-400 hover:text-sky-300 text-xs"
        >
          Сравнить онлайн →
        </Link>
      </div>

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

      <section className="rounded border border-neutral-800 bg-neutral-950 p-4 space-y-2">
        <h2 className="text-xs uppercase tracking-widest text-neutral-400">
          История ников ({names.length})
        </h2>
        {names.length === 0 ? (
          <div className="text-neutral-500 text-sm">только основной ник</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-widest text-neutral-500">
              <tr>
                <th className="text-left p-1">Ник</th>
                <th className="text-left p-1">Виделся N раз</th>
                <th className="text-left p-1">Первый раз</th>
                <th className="text-left p-1">Последний раз</th>
                {canBan ? <th className="text-left p-1"></th> : null}
              </tr>
            </thead>
            <tbody>
              {names.map((n) => (
                <tr key={n.name_normalized} className="border-t border-neutral-900">
                  <td className="p-1 font-medium">{n.name}</td>
                  <td className="p-1 font-mono">{n.observation_count}</td>
                  <td className="p-1 text-neutral-500">
                    {new Date(n.first_seen_at).toLocaleString()}
                  </td>
                  <td className="p-1 text-neutral-500">
                    {new Date(n.last_seen_at).toLocaleString()}
                  </td>
                  {canBan ? (
                    <td className="p-1">
                      <button
                        type="button"
                        onClick={() => setBanTarget(n.name)}
                        className="rounded border border-red-900 px-2 py-0.5 text-xs text-red-400 hover:border-red-700"
                      >
                        Забанить ник
                      </button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

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
    </div>
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
    <section className="rounded border border-neutral-800 bg-neutral-950 p-4 space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-xs uppercase tracking-widest text-neutral-400">Whitelist</h2>
          <p className="mt-1 text-sm text-neutral-300">
            {isWhitelisted ? 'Игрок в whitelist.' : 'Игрок не в whitelist.'}
          </p>
        </div>
        {canEdit ? (
          <button
            type="button"
            onClick={toggle}
            disabled={busy}
            className={`rounded px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-40 ${
              isWhitelisted
                ? 'border border-red-900 text-red-300 hover:border-red-700'
                : 'border border-sky-700 bg-sky-950 text-sky-200 hover:bg-sky-900'
            }`}
          >
            {isWhitelisted ? 'Убрать из whitelist' : 'В whitelist'}
          </button>
        ) : null}
      </div>
      {msg ? (
        <div
          className={`rounded border p-2 text-xs ${
            msg.kind === 'ok'
              ? 'border-emerald-900 bg-emerald-950/50 text-emerald-200'
              : 'border-red-900 bg-red-950 text-red-200'
          }`}
        >
          {msg.text}
        </div>
      ) : null}
    </section>
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
    setExpiresAt(toDatetimeLocalValue(current?.role_expires_at));
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

  return (
    <section className="rounded border border-neutral-800 bg-neutral-950 p-4 space-y-3">
      <h2 className="text-xs uppercase tracking-widest text-neutral-400">Роль</h2>
      {msg ? (
        <div
          className={`rounded border p-2 text-xs ${
            msg.kind === 'ok'
              ? 'border-emerald-900 bg-emerald-950/50 text-emerald-200'
              : 'border-red-900 bg-red-950 text-red-200'
          }`}
        >
          {msg.text}
        </div>
      ) : null}
      {!editing ? (
        <div className="flex items-center gap-3 text-sm">
          {current ? (
            <span className="min-w-0">
              <span className="inline-flex items-center gap-2">
                <RoleColorDot color={current.color} />
                <span className="font-medium">{current.name}</span>
                {current.is_system_role && current.name === 'Owner' ? (
                  <span className="rounded bg-red-950 px-2 py-0.5 text-[10px] uppercase text-red-300">
                    system
                  </span>
                ) : null}
              </span>
              <span className="mt-1 block text-xs text-neutral-500">
                {formatRoleExpiryLabel(current.role_expires_at)}
                {isRoleExpirySoon(current.role_expires_at, DEFAULT_VIP_EXPIRY_WINDOWS_DAYS) ? (
                  <span className="ml-2 rounded bg-amber-950 px-2 py-0.5 text-[10px] uppercase text-amber-300">
                    истекает
                  </span>
                ) : null}
                {current.role_comment ? ` · ${current.role_comment}` : ''}
              </span>
            </span>
          ) : (
            <span className="text-neutral-500">—</span>
          )}
          {canManage ? (
            <>
              {!(current?.is_system_role && current.name === 'Owner') ? (
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  className="rounded border border-neutral-800 px-3 py-0.5 text-xs hover:border-neutral-600"
                >
                  Выдать роль
                </button>
              ) : null}
              {current ? (
                <button
                  type="button"
                  onClick={() => {
                    if (!confirm(`Снять роль «${current.name}» с этого игрока?`)) return;
                    void save(null);
                  }}
                  disabled={busy}
                  className="rounded border border-red-900 px-3 py-0.5 text-xs text-red-400 hover:border-red-700 disabled:opacity-40"
                >
                  Снять роль
                </button>
              ) : null}
            </>
          ) : (
            <span className="text-xs text-neutral-600">read-only</span>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          <div className="grid gap-2 md:grid-cols-[1fr_220px]">
            <select
              value={picked}
              onChange={(e) => setPicked(e.target.value)}
              className="rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm"
            >
              <option value="">— выберите —</option>
              {assignableRoles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
            <input
              type="datetime-local"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
              className="rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm"
            />
          </div>
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            maxLength={512}
            rows={2}
            className="w-full resize-none rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm"
            placeholder="Комментарий"
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => picked && save(picked)}
              disabled={!picked || busy}
              className="rounded bg-sky-600 px-4 py-2 text-sm text-white hover:bg-sky-500 disabled:opacity-40"
            >
              Сохранить
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setPicked('');
              }}
              disabled={busy}
              className="rounded border border-neutral-800 px-4 py-2 text-sm hover:border-neutral-600"
            >
              Отмена
            </button>
          </div>
        </div>
      )}
    </section>
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
  if (!ipsVisible) {
    return (
      <section className="rounded border border-neutral-800 bg-neutral-950 p-4 space-y-3">
        <h2 className="text-xs uppercase tracking-widest text-neutral-400">Локация</h2>
        {locations.length === 0 ? (
          <div className="text-sm text-neutral-500">нет данных о локации</div>
        ) : (
          <ul className="space-y-1 text-sm">
            {locations.map((loc) => (
              <li key={loc.country_code} className="flex items-center gap-2">
                <span>{flagEmoji(loc.country_code)}</span>
                <span>{loc.country_name ?? loc.country_code}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-neutral-600">
          IP и точная локация доступны только пользователям с доступом к панели.
        </p>
      </section>
    );
  }

  const current = ips[0] ?? null;
  const others = ips.slice(1);

  return (
    <section className="rounded border border-neutral-800 bg-neutral-950 p-4 space-y-4">
      <h2 className="text-xs uppercase tracking-widest text-neutral-400">Локация ({ips.length})</h2>

      {current === null ? (
        <div className="text-sm text-neutral-500">пока пусто</div>
      ) : (
        <div className="space-y-2">
          <div className="text-[10px] uppercase tracking-widest text-neutral-500">Текущая</div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <span className="text-lg leading-none">{flagEmoji(current.country_code)}</span>
            {current.country_code ? (
              <span className="font-medium">{locationLabel(current)}</span>
            ) : (
              <span className="text-amber-400/90">
                гео недоступно
                {geoConfigured ? '' : ': добавьте MaxMind ключ в настройках'}
              </span>
            )}
            <span className="font-mono text-neutral-300">{current.ip}</span>
            <span className="text-neutral-500">
              {new Date(current.last_seen_at).toLocaleString()}
            </span>
            <span className="font-mono text-neutral-600">×{current.observation_count}</span>
          </div>
        </div>
      )}

      {others.length > 0 ? (
        <div className="space-y-2">
          <div className="text-[10px] uppercase tracking-widest text-neutral-500">
            Другие локации
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs uppercase tracking-widest text-neutral-500">
                <tr>
                  <th className="text-left p-1">Локация</th>
                  <th className="text-left p-1">IP</th>
                  <th className="text-left p-1">Заходов</th>
                  <th className="text-left p-1">Последний раз</th>
                </tr>
              </thead>
              <tbody>
                {others.map((ip) => (
                  <tr key={ip.ip} className="border-t border-neutral-900">
                    <td className="p-1">
                      <span className="mr-1">{flagEmoji(ip.country_code)}</span>
                      {ip.country_code ? (
                        locationLabel(ip)
                      ) : (
                        <span className="text-amber-400/80">
                          гео недоступно
                          {geoConfigured ? '' : ': добавьте MaxMind ключ'}
                        </span>
                      )}
                    </td>
                    <td className="p-1 font-mono">{ip.ip}</td>
                    <td className="p-1 font-mono">{ip.observation_count}</td>
                    <td className="p-1 text-neutral-500">
                      {new Date(ip.last_seen_at).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      <GeoAnomaliesSection playerId={playerId} />
    </section>
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
