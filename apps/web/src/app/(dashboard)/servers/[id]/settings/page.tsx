'use client';

import {
  type ExternalConnectionResponse,
  type SeedingSettingsResponse,
  type ServerLicenseState,
  type ServerSettingsView,
  serverDetailResponse,
  serverSettingsView,
  sidecarIntegrationResponse,
} from '@squad/shared-types';
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
import { apiSend, describeHttpError } from '@/lib/api';
import { ConnectionSection } from './ConnectionSection';
import {
  describeSettingsError,
  fetchValidated,
  type SidecarIntegration,
  sidecarEngineLabel,
  sidecarModeLabel,
  sidecarStatusPill,
} from './helpers';
import { LicenseSection } from './LicenseSection';
import { LogSourceSection } from './LogSourceSection';
import { SeedingSection } from './SeedingSection';
import { ServerControls } from './ServerControls';
import { useSavedFlag } from './useSavedFlag';

type Settings = ServerSettingsView;

const RULES_TEXT_MAX = 300;

/** Тон пилюли состояния сайдкара; слово в самой пилюле несёт тот же смысл (§5). */
const SIDECAR_PILL_TONE: Record<'green' | 'amber' | 'neutral', BadgeTone> = {
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

interface ServerInfo {
  status: string;
  display_name: string;
  tags: string[];
  /** `external` — размещён вне панели; управляется только по RCON. */
  runtime: string;
  connection: { rcon_host: string | null; rcon_port: number | null } | null;
}

export default function SettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [serverInfo, setServerInfo] = useState<ServerInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, flashSaved, clearSaved] = useSavedFlag();

  const [draft, setDraft] = useState<Partial<Settings>>({});
  const [tags, setTags] = useState<string[]>([]);
  const [license, setLicense] = useState<ServerLicenseState | null>(null);
  const [container, setContainer] = useState<{
    running: boolean;
    started_at: string | null;
  } | null>(null);
  const [sidecar, setSidecar] = useState<SidecarIntegration | null>(null);

  // `resetDraft` is false for a reload triggered by an unrelated save (license
  // attach/detach) — those must not discard other fields' unsaved edits, only
  // refresh what the server now reports (#652).
  const load = useCallback(
    async (resetDraft = true) => {
      try {
        const data = await fetchValidated(`/api/v1/servers/${id}`, serverDetailResponse, 'сервер');
        if (!data.settings) throw new Error('У сервера нет сохранённых настроек');
        setServerInfo({
          status: data.server.status,
          display_name: data.server.display_name,
          tags: data.server.tags ?? [],
          runtime: data.server.runtime ?? 'container',
          connection: data.connection ?? null,
        });
        setTags(data.server.tags ?? []);
        setLicense(data.server.license ?? null);
        setContainer(
          data.container
            ? { running: !!data.container.running, started_at: data.container.started_at ?? null }
            : null,
        );
        setSettings(data.settings);
        setErr(null);
        if (resetDraft) setDraft({});
      } catch (e) {
        setErr(describeHttpError(e));
      }
    },
    [id],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // STATS-4 (#71). Read-only sidecar status, gated on `server:view`; the
  // section self-hides on 403 rather than rendering an error, matching
  // SeedContributionSection. Switching mode stays on
  // POST .../rnsquadjs (`server:stop`) — this section only reports.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await fetchValidated(
          `/api/v1/servers/${id}/rnsquadjs`,
          sidecarIntegrationResponse,
          'сайдкар',
        );
        if (!cancelled) setSidecar(data);
      } catch {
        // best-effort: the section simply stays hidden
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Mirrors the API's PORT_CHANGEABLE_STATUSES (apps/api/src/routes/server-settings.ts) —
  // 'failed' also allows port edits there, so the UI must not disable them for it.
  const isRunning =
    serverInfo && !['stopped', 'ready', 'pending', 'failed'].includes(serverInfo.status);

  function setField<K extends keyof Settings>(key: K, value: Settings[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
    clearSaved();
  }

  async function saveSettings() {
    setBusy(true);
    setErr(null);
    try {
      setSettings(
        await fetchValidated(`/api/v1/servers/${id}/settings`, serverSettingsView, 'настройки', {
          method: 'PUT',
          json: draft,
        }),
      );
      setDraft({});
      flashSaved();
    } catch (e) {
      setErr(describeSettingsError(e));
    } finally {
      setBusy(false);
    }
  }

  function applyConnection(updated: ExternalConnectionResponse) {
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
  }

  function applySeeding(updated: SeedingSettingsResponse) {
    setSettings((prev) => (prev ? { ...prev, ...updated } : prev));
  }

  if (!settings) {
    return (
      <PageContainer width="reading">
        {err ? (
          <InlineBanner
            tone="crit"
            title="Не удалось загрузить настройки сервера"
            description={err}
            action={
              <Button size="sm" onClick={() => void load()}>
                Повторить
              </Button>
            }
          />
        ) : (
          <Skeleton variant="card" count={4} label="Настройки сервера загружаются" />
        )}
      </PageContainer>
    );
  }

  const val = <K extends keyof Settings>(key: K) =>
    draft[key] !== undefined ? draft[key] : settings[key];

  const dirty = Object.keys(draft).length > 0;
  const external = serverInfo?.runtime === 'external';

  return (
    <PageContainer width="reading">
      {err ? <InlineBanner tone="crit" title={err} /> : null}
      {saved ? <InlineBanner tone="good" title="Сохранено" /> : null}

      <ServerControls serverId={id} />

      <GroupedList title="Теги" footnote="Теги помогают фильтровать серверы в списке.">
        <div className="px-4 py-3">
          <TagInput
            tags={tags}
            onChange={async (newTags) => {
              const previousTags = tags;
              setTags(newTags);
              try {
                await apiSend(`/api/v1/servers/${id}`, {
                  method: 'PATCH',
                  json: { tags: newTags },
                });
              } catch (e) {
                setTags(previousTags);
                setErr(`Не удалось сохранить теги: ${describeSettingsError(e)}`);
              }
            }}
          />
        </div>
      </GroupedList>

      {external ? (
        <>
          <ConnectionSection
            serverId={id}
            rconHost={serverInfo?.connection?.rcon_host ?? null}
            rconPort={settings.rcon_port}
            queryPort={settings.query_port}
            gamePort={settings.game_port}
            onSaved={applyConnection}
          />
          <LogSourceSection serverId={id} />
        </>
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
        footnote="Игровые команды !stats, !rules, !report выполняются через RCON. Отключите, если сайдкар SquadJS обрабатывает чат-команды сам."
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

      {sidecar ? (
        <GroupedList
          title="Интеграция SquadJS"
          footnote="Переключение режима выполняется отдельным правом server:stop; эта секция только показывает состояние."
        >
          <GroupedRow
            label="Движок сайдкара"
            control={<Badge>{sidecarEngineLabel(sidecar.mode)}</Badge>}
          />
          <GroupedRow
            label="Источник событий"
            description={sidecarModeLabel(sidecar.mode).hint}
            control={<Badge>{sidecarModeLabel(sidecar.mode).title}</Badge>}
          />
          <GroupedRow
            label="Связь сайдкара"
            control={
              <Badge tone={SIDECAR_PILL_TONE[sidecarStatusPill(sidecar.status).tone]}>
                {sidecarStatusPill(sidecar.status).text}
              </Badge>
            }
          />
          <GroupedRow
            label="Переключён на сайдкар"
            control={<span className="text-[13px] text-ink">{sidecar.cutover ? 'Да' : 'Нет'}</span>}
          />
          <GroupedRow
            label="Последнее изменение связи"
            control={
              <span className="text-[13px] tabular-nums text-ink">
                {sidecar.status
                  ? new Date(sidecar.status.last_change).toLocaleString('ru-RU')
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

      <SeedingSection
        serverId={id}
        seedLiveAt={settings.seed_live_at}
        seedHysteresis={settings.seed_hysteresis}
        onSaved={applySeeding}
      />

      {external ? null : (
        <LicenseSection
          serverId={id}
          license={license}
          container={container}
          onChanged={() => load(false)}
        />
      )}

      <div className="flex justify-end">
        <Button variant="primary" disabled={!dirty} loading={busy} onClick={saveSettings}>
          Сохранить
        </Button>
      </div>
    </PageContainer>
  );
}
