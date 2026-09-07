'use client';

import { use, useCallback, useEffect, useState } from 'react';
import { TagInput } from '@/components/TagInput';
import {
  Badge,
  type BadgeTone,
  Button,
  FieldRow,
  GroupedList,
  GroupedRow,
  InlineBanner,
  PageContainer,
  Skeleton,
  Switch,
  Textarea,
  TextInput,
} from '@/components/ui';
import {
  licenseRestartRequired,
  type RnsquadjsIntegration,
  rnsquadjsModeLabel,
  rnsquadjsStatusPill,
} from './helpers';

interface Settings {
  server_id: string;
  game_port: number;
  query_port: number;
  beacon_port: number;
  rcon_port: number;
  max_players: number;
  tickrate: number;
  multihome: string | null;
  extra_args: string;
  cpu_affinity: string | null;
  cpu_weight: number | null;
  niceness: number | null;
  memory_high_mb: number | null;
  memory_max_mb: number | null;
  io_weight: number | null;
  seed_live_at: number;
  seed_hysteresis: number;
  chat_commands_enabled: boolean;
  rules_text: string | null;
  archive_logs_to_backup: boolean;
}

const RULES_TEXT_MAX = 300;

/** Тон пилюли состояния сайдкара; слово в самой пилюле несёт тот же смысл (§5). */
const RNSQUADJS_PILL_TONE: Record<'green' | 'amber' | 'neutral', BadgeTone> = {
  green: 'good',
  amber: 'warn',
  neutral: 'neutral',
};

/** Сетевые порты сервера: ключ настройки и подпись строки. */
const PORT_FIELDS = [
  ['game_port', 'Игровой порт'],
  ['query_port', 'Порт запросов'],
  ['beacon_port', 'Порт маяка'],
  ['rcon_port', 'Порт RCON'],
] as const;

/** Лимиты ресурсов контейнера: ключ настройки, подпись строки и минимум. */
const RESOURCE_FIELDS = [
  ['memory_high_mb', 'Память, мягкий предел (МБ)', 2048],
  ['memory_max_mb', 'Память, жёсткий предел (МБ)', 2048],
  ['cpu_weight', 'Вес CPU', 1],
  ['io_weight', 'Вес ввода-вывода', 10],
  ['niceness', 'Приоритет (nice)', -20],
] as const;

interface ServerInfo {
  status: string;
  display_name: string;
  tags: string[];
  /** `external` — размещён вне панели; управляется только по RCON. */
  runtime: string;
  connection: { rcon_host: string | null; rcon_port: number | null } | null;
}

/** Источник логов внешнего сервера: SSH-хвост SquadGame.log на игровом хосте. */
interface LogSourceView {
  configured: boolean;
  ssh_host?: string;
  ssh_port?: number;
  ssh_user?: string;
  log_path?: string;
  enabled?: boolean;
  public_key?: string;
  host_key_fingerprint?: string | null;
  key_version?: number;
  status: {
    state: 'connecting' | 'connected' | 'error';
    ts: string;
    lines?: number;
    last_line_at?: string | null;
    error?: string | null;
  } | null;
}

interface LogSourceDraft {
  ssh_host: string;
  ssh_port: number;
  ssh_user: string;
  log_path: string;
  enabled: boolean;
}

const LOG_SOURCE_DEFAULTS: LogSourceDraft = {
  ssh_host: '',
  ssh_port: 22,
  ssh_user: 'squad',
  log_path: '/opt/squad1/SquadGame/Saved/Logs/SquadGame.log',
  enabled: true,
};

/** Состояние SSH-хвоста словами; тон дублирует подпись (§5). */
const LOG_SOURCE_STATE: Record<string, { tone: BadgeTone; label: string }> = {
  connected: { tone: 'good', label: 'читается' },
  connecting: { tone: 'warn', label: 'подключение' },
  error: { tone: 'crit', label: 'ошибка' },
};

/** Черновик правок RCON-подключения внешнего сервера; пустой пароль = не менять. */
interface ConnectionDraft {
  rcon_host?: string;
  rcon_port?: number;
  rcon_password?: string;
  query_port?: number;
  game_port?: number;
}

interface LicenseState {
  configured: boolean;
  license_id: string | null;
  updated_at: string | null;
  restart_required: boolean;
}

export default function SettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [serverInfo, setServerInfo] = useState<ServerInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const [draft, setDraft] = useState<Partial<Settings>>({});
  const [tags, setTags] = useState<string[]>([]);
  const [licenseId, setLicenseId] = useState('');
  const [licenseKey, setLicenseKey] = useState('');
  const [license, setLicense] = useState<LicenseState | null>(null);
  const [container, setContainer] = useState<{
    running: boolean;
    started_at: string | null;
  } | null>(null);

  const [canManageServer, setCanManageServer] = useState(false);
  const [rnsquadjs, setRnsquadjs] = useState<RnsquadjsIntegration | null>(null);
  const [seedingDraft, setSeedingDraft] = useState<{
    seed_live_at?: number;
    seed_hysteresis?: number;
  }>({});
  const [seedingBusy, setSeedingBusy] = useState(false);
  const [seedingSaved, setSeedingSaved] = useState(false);
  const [seedingErr, setSeedingErr] = useState<string | null>(null);
  const [connectionDraft, setConnectionDraft] = useState<ConnectionDraft>({});
  const [connectionBusy, setConnectionBusy] = useState(false);
  const [connectionSaved, setConnectionSaved] = useState(false);
  const [connectionErr, setConnectionErr] = useState<string | null>(null);
  const [logSource, setLogSource] = useState<LogSourceView | null>(null);
  const [logSourceDraft, setLogSourceDraft] = useState<LogSourceDraft>(LOG_SOURCE_DEFAULTS);
  const [logSourceDirty, setLogSourceDirty] = useState(false);
  const [logSourceBusy, setLogSourceBusy] = useState(false);
  const [logSourceErr, setLogSourceErr] = useState<string | null>(null);
  const [logSourceSaved, setLogSourceSaved] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/v1/servers/${id}`, { credentials: 'include', cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      setServerInfo({
        status: data.server.status,
        display_name: data.server.display_name,
        tags: data.server.tags ?? [],
        runtime: data.server.runtime ?? 'container',
        connection: data.connection ?? null,
      });
      setTags(data.server.tags ?? []);
      const lic = (data.server.license ?? null) as LicenseState | null;
      setLicense(lic);
      setLicenseId(lic?.license_id ?? '');
      setContainer(
        data.container
          ? { running: !!data.container.running, started_at: data.container.started_at ?? null }
          : null,
      );
      setSettings(data.settings);
      setDraft({});
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Источник логов есть только у внешнего сервера; для контейнерного API
  // отвечает 409, и секция не показывается вовсе.
  const isExternalServer = serverInfo?.runtime === 'external';
  useEffect(() => {
    if (!isExternalServer) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/v1/servers/${id}/log-source`, {
          credentials: 'include',
          cache: 'no-store',
        });
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as LogSourceView;
        if (cancelled) return;
        setLogSource(data);
        if (data.configured) {
          setLogSourceDraft({
            ssh_host: data.ssh_host ?? '',
            ssh_port: data.ssh_port ?? 22,
            ssh_user: data.ssh_user ?? 'squad',
            log_path: data.log_path ?? LOG_SOURCE_DEFAULTS.log_path,
            enabled: data.enabled ?? true,
          });
        }
      } catch {
        // best-effort: the section shows the empty form
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, isExternalServer]);

  async function saveLogSource(regenerateKey = false) {
    setLogSourceBusy(true);
    setLogSourceErr(null);
    try {
      const res = await fetch(`/api/v1/servers/${id}/log-source`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...logSourceDraft, regenerate_key: regenerateKey }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
      }
      setLogSource((await res.json()) as LogSourceView);
      setLogSourceDirty(false);
      setLogSourceSaved(true);
      setTimeout(() => setLogSourceSaved(false), 2000);
    } catch (e) {
      setLogSourceErr((e as Error).message);
    } finally {
      setLogSourceBusy(false);
    }
  }

  async function removeLogSource() {
    setLogSourceBusy(true);
    setLogSourceErr(null);
    try {
      const res = await fetch(`/api/v1/servers/${id}/log-source`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
      setLogSource({ configured: false, status: null });
      setLogSourceDraft(LOG_SOURCE_DEFAULTS);
      setLogSourceDirty(false);
    } catch (e) {
      setLogSourceErr((e as Error).message);
    } finally {
      setLogSourceBusy(false);
    }
  }

  function setLogSourceField<K extends keyof LogSourceDraft>(key: K, value: LogSourceDraft[K]) {
    setLogSourceDraft((prev) => ({ ...prev, [key]: value }));
    setLogSourceDirty(true);
    setLogSourceSaved(false);
  }

  // The "Пороги сидинга" section is gated on the `manageserver` squad
  // permission (not `server:edit_settings`, which governs the rest of this
  // page) — hidden entirely rather than shown-then-403'd, mirroring how
  // the chat composer on the detail page checks `/api/v1/me` up front.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/v1/me', { credentials: 'include', cache: 'no-store' });
        if (!res.ok || cancelled) return;
        const me = (await res.json()) as { squad_permissions?: string[] };
        if (!cancelled) setCanManageServer(me.squad_permissions?.includes('manageserver') ?? false);
      } catch {
        // permission fetch is best-effort; the section simply stays hidden
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // STATS-4 (#71). Read-only sidecar status, gated on `server:view`; the
  // section self-hides on 403 rather than rendering an error, matching
  // SeedContributionSection. Cutover/rollback stays on the server detail page's
  // controls (POST .../rnsquadjs, `server:stop`) — this section only reports.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/v1/servers/${id}/rnsquadjs`, {
          credentials: 'include',
          cache: 'no-store',
        });
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as RnsquadjsIntegration;
        if (!cancelled) setRnsquadjs(data);
      } catch {
        // best-effort: the section simply stays hidden
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  const isRunning = serverInfo && !['stopped', 'ready', 'pending'].includes(serverInfo.status);

  function setField<K extends keyof Settings>(key: K, value: Settings[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  }

  async function saveSettings() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/v1/servers/${id}/settings`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(draft),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
      }
      const updated = (await res.json()) as Settings;
      setSettings(updated);
      setDraft({});
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function saveConnection() {
    setConnectionBusy(true);
    setConnectionErr(null);
    try {
      const res = await fetch(`/api/v1/servers/${id}/external-connection`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(connectionDraft),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
      }
      const updated = (await res.json()) as {
        rcon_host: string | null;
        rcon_port: number | null;
        query_port: number | null;
        game_port: number | null;
      };
      setServerInfo((prev) =>
        prev
          ? { ...prev, connection: { rcon_host: updated.rcon_host, rcon_port: updated.rcon_port } }
          : prev,
      );
      setSettings((prev) =>
        prev
          ? {
              ...prev,
              rcon_port: updated.rcon_port ?? prev.rcon_port,
              query_port: updated.query_port ?? prev.query_port,
              game_port: updated.game_port ?? prev.game_port,
            }
          : prev,
      );
      setConnectionDraft({});
      setConnectionSaved(true);
      setTimeout(() => setConnectionSaved(false), 2000);
    } catch (e) {
      setConnectionErr((e as Error).message);
    } finally {
      setConnectionBusy(false);
    }
  }

  async function saveSeedingSettings() {
    setSeedingBusy(true);
    setSeedingErr(null);
    try {
      const res = await fetch(`/api/v1/servers/${id}/seeding-settings`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(seedingDraft),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
      }
      const updated = (await res.json()) as { seed_live_at: number; seed_hysteresis: number };
      setSettings((prev) => (prev ? { ...prev, ...updated } : prev));
      setSeedingDraft({});
      setSeedingSaved(true);
      setTimeout(() => setSeedingSaved(false), 2000);
    } catch (e) {
      setSeedingErr((e as Error).message);
    } finally {
      setSeedingBusy(false);
    }
  }

  async function saveLicense() {
    setBusy(true);
    setErr(null);
    try {
      // ID-only edit: with a key already stored, an empty key field means
      // "keep the stored key" — send only the id.
      const payload: { license_id: string; license_key?: string } = { license_id: licenseId };
      if (licenseKey) payload.license_key = licenseKey;
      const r = await fetch(`/api/v1/servers/${id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.message ?? body.error ?? `HTTP ${r.status}`);
      }
      setLicenseKey('');
      await load();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function detachLicense() {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/v1/servers/${id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ license_id: null, license_key: null }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.message ?? body.error ?? `HTTP ${r.status}`);
      }
      setLicenseId('');
      setLicenseKey('');
      await load();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!settings) {
    return (
      <PageContainer width="reading">
        <Skeleton variant="card" count={4} label="Настройки сервера загружаются" />
      </PageContainer>
    );
  }

  const val = <K extends keyof Settings>(key: K) =>
    draft[key] !== undefined ? draft[key] : settings[key];

  const dirty = Object.keys(draft).length > 0;
  const external = serverInfo?.runtime === 'external';
  const connectionDirty = Object.keys(connectionDraft).length > 0;

  return (
    <PageContainer width="reading">
      {err ? <InlineBanner tone="crit" title={err} /> : null}
      {saved ? <InlineBanner tone="good" title="Сохранено" /> : null}

      <GroupedList title="Теги" footnote="Теги помогают фильтровать серверы в списке.">
        <div className="px-4 py-3">
          <TagInput
            tags={tags}
            onChange={async (newTags) => {
              setTags(newTags);
              try {
                await fetch(`/api/v1/servers/${id}`, {
                  method: 'PATCH',
                  credentials: 'include',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ tags: newTags }),
                });
              } catch {
                /* best effort */
              }
            }}
          />
        </div>
      </GroupedList>

      {external ? (
        <div className="space-y-3">
          {connectionErr ? <InlineBanner tone="crit" title={connectionErr} /> : null}
          {connectionSaved ? <InlineBanner tone="good" title="Подключение сохранено" /> : null}
          <GroupedList
            title="RCON-подключение"
            footnote="Внешний сервер: панель не управляет его процессом, а подключается по этим параметрам. worker-rcon переподключится в течение 15 секунд после сохранения."
          >
            <GroupedRow
              label="Адрес RCON"
              description="Имя хоста или IP"
              control={
                <div className="w-56">
                  <TextInput
                    aria-label="Адрес RCON"
                    value={connectionDraft.rcon_host ?? serverInfo?.connection?.rcon_host ?? ''}
                    onChange={(e) => {
                      setConnectionDraft((prev) => ({ ...prev, rcon_host: e.target.value.trim() }));
                      setConnectionSaved(false);
                    }}
                    autoComplete="off"
                  />
                </div>
              }
            />
            <GroupedRow
              label="Порт RCON"
              description="TCP"
              control={
                <div className="w-28">
                  <TextInput
                    type="number"
                    aria-label="Порт RCON"
                    value={connectionDraft.rcon_port ?? settings.rcon_port}
                    onChange={(e) => {
                      setConnectionDraft((prev) => ({
                        ...prev,
                        rcon_port: Number(e.target.value),
                      }));
                      setConnectionSaved(false);
                    }}
                    min={1}
                    max={65535}
                  />
                </div>
              }
            />
            <GroupedRow
              label="Пароль RCON"
              description="Пустое поле — оставить сохранённый"
              control={
                <div className="w-56">
                  <TextInput
                    type="password"
                    aria-label="Пароль RCON"
                    value={connectionDraft.rcon_password ?? ''}
                    onChange={(e) => {
                      const next = e.target.value;
                      setConnectionDraft((prev) => {
                        const { rcon_password: _drop, ...rest } = prev;
                        return next === '' ? rest : { ...rest, rcon_password: next };
                      });
                      setConnectionSaved(false);
                    }}
                    autoComplete="new-password"
                    placeholder="••••••••  (сохранён)"
                  />
                </div>
              }
            />
            <GroupedRow
              label="Порт запросов"
              description="UDP, A2S"
              control={
                <div className="w-28">
                  <TextInput
                    type="number"
                    aria-label="Порт запросов"
                    value={connectionDraft.query_port ?? settings.query_port}
                    onChange={(e) => {
                      setConnectionDraft((prev) => ({
                        ...prev,
                        query_port: Number(e.target.value),
                      }));
                      setConnectionSaved(false);
                    }}
                    min={1}
                    max={65535}
                  />
                </div>
              }
            />
            <GroupedRow
              label="Игровой порт"
              description="UDP"
              control={
                <div className="w-28">
                  <TextInput
                    type="number"
                    aria-label="Игровой порт"
                    value={connectionDraft.game_port ?? settings.game_port}
                    onChange={(e) => {
                      setConnectionDraft((prev) => ({
                        ...prev,
                        game_port: Number(e.target.value),
                      }));
                      setConnectionSaved(false);
                    }}
                    min={1}
                    max={65535}
                  />
                </div>
              }
            />
          </GroupedList>
          <div className="flex justify-end">
            <Button
              variant="primary"
              disabled={!connectionDirty}
              loading={connectionBusy}
              onClick={saveConnection}
            >
              Сохранить подключение
            </Button>
          </div>

          {logSourceErr ? <InlineBanner tone="crit" title={logSourceErr} /> : null}
          {logSourceSaved ? <InlineBanner tone="good" title="Источник логов сохранён" /> : null}
          <GroupedList
            title="Источник логов (SSH)"
            footnote="worker-log-ingest подключается к игровому хосту по SSH и читает SquadGame.log командой tail -F — так же, как бот соперника читает консоль в screen. Бой, ранения, коннекты и матчи появятся после того, как публичный ключ панели добавят в ~/.ssh/authorized_keys пользователя на хосте."
          >
            {logSource?.configured ? (
              <GroupedRow
                label="Состояние"
                description={
                  logSource.status?.error
                    ? logSource.status.error
                    : logSource.status?.last_line_at
                      ? `Последняя строка: ${new Date(logSource.status.last_line_at).toLocaleString('ru-RU')}`
                      : 'worker-log-ingest ещё не отчитался'
                }
                control={
                  <Badge tone={LOG_SOURCE_STATE[logSource.status?.state ?? '']?.tone ?? 'neutral'}>
                    {LOG_SOURCE_STATE[logSource.status?.state ?? '']?.label ?? 'нет данных'}
                  </Badge>
                }
              />
            ) : null}
            <GroupedRow
              label="Хост SSH"
              description="Имя хоста или IP игрового сервера"
              control={
                <div className="w-56">
                  <TextInput
                    aria-label="Хост SSH"
                    value={logSourceDraft.ssh_host}
                    onChange={(e) => setLogSourceField('ssh_host', e.target.value.trim())}
                    autoComplete="off"
                  />
                </div>
              }
            />
            <GroupedRow
              label="Порт SSH"
              control={
                <div className="w-28">
                  <TextInput
                    type="number"
                    aria-label="Порт SSH"
                    value={logSourceDraft.ssh_port}
                    onChange={(e) => setLogSourceField('ssh_port', Number(e.target.value))}
                    min={1}
                    max={65535}
                  />
                </div>
              }
            />
            <GroupedRow
              label="Пользователь SSH"
              control={
                <div className="w-56">
                  <TextInput
                    aria-label="Пользователь SSH"
                    value={logSourceDraft.ssh_user}
                    onChange={(e) => setLogSourceField('ssh_user', e.target.value.trim())}
                    autoComplete="off"
                  />
                </div>
              }
            />
            <div className="px-4 py-3">
              <FieldRow
                label="Путь к SquadGame.log"
                hint="Абсолютный путь на игровом хосте; допустимы латиница, цифры, точка, дефис, подчёркивание."
              >
                <TextInput
                  value={logSourceDraft.log_path}
                  onChange={(e) => setLogSourceField('log_path', e.target.value.trim())}
                  placeholder="/opt/squad1/SquadGame/Saved/Logs/SquadGame.log"
                />
              </FieldRow>
            </div>
            <GroupedRow
              label="Читать логи"
              description="Выключите, чтобы остановить хвост, не удаляя настройки"
              control={
                <Switch
                  checked={logSourceDraft.enabled}
                  onChange={(next) => setLogSourceField('enabled', next)}
                  label="Читать логи"
                />
              }
            />
            {logSource?.configured && logSource.public_key ? (
              <div className="px-4 py-3">
                <FieldRow
                  label="Публичный ключ панели"
                  hint={`Добавьте эту строку в ~/.ssh/authorized_keys пользователя ${logSourceDraft.ssh_user || 'squad'} на игровом хосте. Ключ №${logSource.key_version ?? 1}${logSource.host_key_fingerprint ? `, отпечаток хоста ${logSource.host_key_fingerprint}` : ''}.`}
                >
                  <Textarea
                    value={logSource.public_key}
                    readOnly
                    rows={3}
                    aria-label="Публичный ключ панели"
                  />
                </FieldRow>
              </div>
            ) : null}
          </GroupedList>
          <div className="flex justify-end gap-2">
            {logSource?.configured ? (
              <>
                <Button disabled={logSourceBusy} onClick={removeLogSource}>
                  Удалить источник
                </Button>
                <Button disabled={logSourceBusy} onClick={() => saveLogSource(true)}>
                  Перевыпустить ключ
                </Button>
              </>
            ) : null}
            <Button
              variant="primary"
              disabled={!logSourceDirty && !!logSource?.configured}
              loading={logSourceBusy}
              onClick={() => saveLogSource(false)}
            >
              {logSource?.configured ? 'Сохранить источник' : 'Создать источник и ключ'}
            </Button>
          </div>
        </div>
      ) : (
        <GroupedList
          title="Сеть"
          footnote={
            isRunning
              ? 'Порты меняются только на остановленном сервере — остановите его, чтобы поля стали доступны.'
              : 'Порты применяются при следующем запуске сервера.'
          }
        >
          {PORT_FIELDS.map(([key, label]) => (
            <GroupedRow
              key={key}
              label={label}
              control={
                <div className="w-28">
                  <TextInput
                    type="number"
                    aria-label={label}
                    value={val(key) as number}
                    onChange={(e) => setField(key, Number(e.target.value))}
                    disabled={!!isRunning}
                    min={1024}
                    max={65535}
                  />
                </div>
              }
            />
          ))}
        </GroupedList>
      )}

      <GroupedList title="Игра">
        <GroupedRow
          label="Максимум игроков"
          control={
            <div className="w-28">
              <TextInput
                type="number"
                aria-label="Максимум игроков"
                value={val('max_players') as number}
                onChange={(e) => setField('max_players', Number(e.target.value))}
                min={1}
                max={100}
              />
            </div>
          }
        />
        <GroupedRow
          label="Тикрейт"
          control={
            <div className="w-28">
              <TextInput
                type="number"
                aria-label="Тикрейт"
                value={val('tickrate') as number}
                onChange={(e) => setField('tickrate', Number(e.target.value))}
                min={10}
                max={60}
              />
            </div>
          }
        />
      </GroupedList>

      <GroupedList
        title="Чат-команды"
        footnote="Игровые команды !stats, !rules, !report выполняются через RCON. Отключите, если RNSquadJS обрабатывает чат-команды сам."
      >
        <GroupedRow
          label="Включить игровые чат-команды"
          description="Панель отвечает на команды игроков в игровом чате"
          control={
            <Switch
              checked={val('chat_commands_enabled') as boolean}
              onChange={(next) => setField('chat_commands_enabled', next)}
              label="Включить игровые чат-команды"
            />
          }
        />
        <div className="px-4 py-3">
          <FieldRow label="Текст для !rules" hint={`Не длиннее ${RULES_TEXT_MAX} символов.`}>
            <Textarea
              value={(val('rules_text') as string | null) ?? ''}
              onChange={(e) =>
                setField('rules_text', e.target.value === '' ? null : e.target.value)
              }
              maxLength={RULES_TEXT_MAX}
              rows={3}
              placeholder="Правила не заданы"
            />
          </FieldRow>
        </div>
      </GroupedList>

      {rnsquadjs ? (
        <GroupedList
          title="Интеграция RNSquadJS"
          footnote="Переключение и откат сайдкара выполняются отдельным правом server:stop; эта секция только показывает состояние."
        >
          <GroupedRow
            label="Источник событий"
            description={rnsquadjsModeLabel(rnsquadjs.mode).hint}
            control={<Badge>{rnsquadjsModeLabel(rnsquadjs.mode).title}</Badge>}
          />
          <GroupedRow
            label="Связь сайдкара"
            control={
              <Badge tone={RNSQUADJS_PILL_TONE[rnsquadjsStatusPill(rnsquadjs.status).tone]}>
                {rnsquadjsStatusPill(rnsquadjs.status).text}
              </Badge>
            }
          />
          <GroupedRow
            label="Переключён на сайдкар"
            control={
              <span className="text-[13px] text-ink">{rnsquadjs.cutover ? 'Да' : 'Нет'}</span>
            }
          />
          <GroupedRow
            label="Последнее изменение связи"
            control={
              <span className="text-[13px] tabular-nums text-ink">
                {rnsquadjs.status
                  ? new Date(rnsquadjs.status.last_change).toLocaleString('ru-RU')
                  : '—'}
              </span>
            }
          />
        </GroupedList>
      ) : null}

      {external ? null : (
        <GroupedList
          title="Архив логов"
          footnote="Перед удалением по 10-дневному retention ротированный SquadGame*.log копируется в restic-бэкап (хранение 7д/4н/6м). По умолчанию отключено."
        >
          <GroupedRow
            label="Архивировать в backup перед удалением"
            control={
              <Switch
                checked={val('archive_logs_to_backup') as boolean}
                onChange={(next) => setField('archive_logs_to_backup', next)}
                label="Архивировать в backup перед удалением"
              />
            }
          />
        </GroupedList>
      )}

      {canManageServer ? (
        <div className="space-y-3">
          {seedingErr ? <InlineBanner tone="crit" title={seedingErr} /> : null}
          {seedingSaved ? <InlineBanner tone="good" title="Сохранено" /> : null}
          <GroupedList
            title="Пороги сидинга"
            footnote="Сервер считается «живым», когда игроков не меньше порога; гистерезис не даёт состоянию дрожать у границы."
          >
            <GroupedRow
              label="Порог live"
              description="Игроков"
              control={
                <div className="w-28">
                  <TextInput
                    type="number"
                    aria-label="Порог live (игроков)"
                    value={seedingDraft.seed_live_at ?? settings.seed_live_at}
                    onChange={(e) => {
                      setSeedingDraft((prev) => ({
                        ...prev,
                        seed_live_at: Number(e.target.value),
                      }));
                      setSeedingSaved(false);
                    }}
                    min={1}
                    max={200}
                  />
                </div>
              }
            />
            <GroupedRow
              label="Гистерезис"
              description="Игроков"
              control={
                <div className="w-28">
                  <TextInput
                    type="number"
                    aria-label="Гистерезис (игроков)"
                    value={seedingDraft.seed_hysteresis ?? settings.seed_hysteresis}
                    onChange={(e) => {
                      setSeedingDraft((prev) => ({
                        ...prev,
                        seed_hysteresis: Number(e.target.value),
                      }));
                      setSeedingSaved(false);
                    }}
                    min={0}
                    max={50}
                  />
                </div>
              }
            />
          </GroupedList>
          <div className="flex justify-end">
            <Button
              variant="primary"
              disabled={Object.keys(seedingDraft).length === 0}
              loading={seedingBusy}
              onClick={saveSeedingSettings}
            >
              Сохранить пороги
            </Button>
          </div>
        </div>
      ) : null}

      {external ? null : (
        <GroupedList title="Ресурсы" footnote="Применяется при следующем запуске.">
          {RESOURCE_FIELDS.map(([key, label, min]) => (
            <GroupedRow
              key={key}
              label={label}
              control={
                <div className="w-32">
                  <TextInput
                    type="number"
                    aria-label={label}
                    value={(val(key) as number | null) ?? ''}
                    onChange={(e) =>
                      setField(key, e.target.value === '' ? null : Number(e.target.value))
                    }
                    min={min}
                    placeholder="Нет лимита"
                  />
                </div>
              }
            />
          ))}
          <GroupedRow
            label="Привязка к ядрам (CPU affinity)"
            control={
              <div className="w-32">
                <TextInput
                  aria-label="Привязка к ядрам (CPU affinity)"
                  value={(val('cpu_affinity') as string | null) ?? ''}
                  onChange={(e) =>
                    setField('cpu_affinity', e.target.value === '' ? null : e.target.value)
                  }
                  placeholder="Нет ограничения"
                />
              </div>
            }
          />
        </GroupedList>
      )}

      {external ? null : (
        <div className="space-y-3">
          <GroupedList
            title="Лицензия"
            footnote={
              licenseRestartRequired(
                license?.updated_at ?? null,
                container?.running ?? false,
                container?.started_at ?? null,
              )
                ? 'Лицензия сохранена и применится после перезапуска сервера.'
                : license?.configured
                  ? 'Лицензия привязана и применена.'
                  : 'License.cfg записывается панелью; применяется после перезапуска сервера.'
            }
          >
            {licenseRestartRequired(
              license?.updated_at ?? null,
              container?.running ?? false,
              container?.started_at ?? null,
            ) ? (
              <GroupedRow
                label="Нужен перезапуск"
                description="Лицензия сохранена и применится после перезапуска сервера"
                control={<Badge tone="warn">рестарт</Badge>}
              />
            ) : null}
            <GroupedRow
              label="ID лицензии"
              control={
                <div className="w-56">
                  <TextInput
                    aria-label="ID лицензии"
                    value={licenseId}
                    onChange={(e) => setLicenseId(e.target.value)}
                    placeholder="Не указан"
                  />
                </div>
              }
            />
            <GroupedRow
              label="Ключ лицензии"
              control={
                <div className="w-56">
                  <TextInput
                    type="password"
                    aria-label="Ключ лицензии"
                    value={licenseKey}
                    onChange={(e) => setLicenseKey(e.target.value)}
                    placeholder={license?.configured ? '••••••••  (сохранён)' : 'Не указан'}
                  />
                </div>
              }
            />
          </GroupedList>
          <div className="flex justify-end gap-2">
            {/* Отвязка обратима — лицензию можно привязать снова, поэтому кнопка
              вторичная, а не критическая (§5). */}
            <Button disabled={busy} onClick={detachLicense}>
              Отвязать
            </Button>
            <Button
              variant="primary"
              disabled={!licenseId || (!licenseKey && !license?.configured) || busy}
              onClick={saveLicense}
            >
              Привязать
            </Button>
          </div>
        </div>
      )}

      <div className="flex justify-end">
        <Button variant="primary" disabled={!dirty} loading={busy} onClick={saveSettings}>
          Сохранить
        </Button>
      </div>
    </PageContainer>
  );
}
