'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import {
  AlertDialog,
  Badge,
  type BadgeTone,
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  EmptyState,
  FieldRow,
  IconButton,
  InlineBanner,
  PageContainer,
  PageHeader,
  Select,
  Skeleton,
  Switch,
  TextInput,
  TrashIcon,
} from '@/components/ui';
import { PublicationSection } from './PublicationSection';

interface BanSource {
  id: string;
  name: string;
  url: string;
  format: string;
  trust_level: string;
  on_match: string;
  discord_url: string | null;
  enabled: boolean;
  poll_interval_minutes: number;
  last_sync_at: string | null;
  last_sync_status: string | null;
  last_sync_error: string | null;
  imported_count: number;
  record_count: number;
  has_auth_header: boolean;
  created_at: string;
}

interface Me {
  permissions: string[];
  can_manage_ban_sources: boolean;
}

const FORMAT_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'squad_bans_cfg', label: 'Squad Bans.cfg' },
  { value: 'battlemetrics_json', label: 'BattleMetrics JSON' },
  { value: 'json_generic', label: 'JSON (generic)' },
  { value: 'csv', label: 'CSV' },
];

const TRUST_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'trusted', label: 'Доверенный' },
  { value: 'normal', label: 'Обычный' },
  { value: 'low', label: 'Низкий' },
];

const ON_MATCH_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'none', label: 'Только запись события' },
  { value: 'alert', label: 'Алерт без кика' },
  { value: 'kick', label: 'Кик (только trusted)' },
];

/** Тон бейджа доверия. Смысл несёт подпись — цвет только ускоряет просмотр (§5). */
const TRUST_TONE: Record<string, BadgeTone> = {
  trusted: 'good',
  normal: 'accent',
  low: 'warn',
};

function trustLabel(level: string): string {
  return TRUST_OPTIONS.find((option) => option.value === level)?.label ?? level;
}

function formatLabel(format: string): string {
  return FORMAT_OPTIONS.find((option) => option.value === format)?.label ?? format;
}

function formatDate(iso: string | null): string {
  if (!iso) return 'никогда';
  return new Date(iso).toLocaleString('ru-RU');
}

const EMPTY_FORM = {
  name: '',
  url: '',
  format: 'squad_bans_cfg',
  trust_level: 'normal',
  on_match: 'alert',
  discord_url: '',
  auth_header: '',
  poll_interval_minutes: 60,
};

/** Показатель источника: служебный ярлык над значением (§1). */
function SourceStat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-2xs uppercase tracking-[0.06em] text-ink-3">{label}</span>
      <span className="text-[13px]">{value}</span>
    </div>
  );
}

export default function BanSourcesPage() {
  const [sources, setSources] = useState<BanSource[] | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<BanSource | null>(null);

  const formId = useId();

  const refresh = useCallback(async () => {
    const [sourcesRes, meRes] = await Promise.all([
      fetch('/api/v1/ban-sources', { credentials: 'include', cache: 'no-store' }),
      fetch('/api/v1/me', { credentials: 'include', cache: 'no-store' }),
    ]);
    if (sourcesRes.ok) {
      setSources((await sourcesRes.json()) as BanSource[]);
      setError(null);
    }
    if (meRes.ok) setMe((await meRes.json()) as Me);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const canManage = me?.can_manage_ban_sources ?? false;

  async function createSource(event: React.FormEvent) {
    event.preventDefault();
    if (!form.name.trim() || !form.url.trim()) {
      setError('Укажите имя и URL источника.');
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const res = await fetch('/api/v1/ban-sources', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: form.name.trim(),
          url: form.url.trim(),
          format: form.format,
          trust_level: form.trust_level,
          on_match: form.on_match,
          discord_url: form.discord_url.trim() || null,
          auth_header: form.auth_header.trim() || null,
          poll_interval_minutes: form.poll_interval_minutes,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        throw new Error(String(body.error ?? res.status));
      }
      setForm({ ...EMPTY_FORM });
      await refresh();
    } catch (err) {
      setError(`Не удалось создать источник: ${(err as Error).message}`);
    } finally {
      setCreating(false);
    }
  }

  async function toggleEnabled(source: BanSource) {
    if (!canManage) return;
    setBusyId(source.id);
    setError(null);
    try {
      const res = await fetch(`/api/v1/ban-sources/${source.id}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: !source.enabled }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await refresh();
    } catch (err) {
      setError(`Не удалось изменить статус: ${(err as Error).message}`);
    } finally {
      setBusyId(null);
    }
  }

  async function syncNow(source: BanSource) {
    if (!canManage) return;
    setBusyId(source.id);
    setError(null);
    try {
      const res = await fetch(`/api/v1/ban-sources/${source.id}/sync`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await refresh();
    } catch (err) {
      setError(`Синхронизация не удалась: ${(err as Error).message}`);
    } finally {
      setBusyId(null);
    }
  }

  async function removeSource(source: BanSource) {
    if (!canManage) return;
    setBusyId(source.id);
    setError(null);
    try {
      const res = await fetch(`/api/v1/ban-sources/${source.id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setPendingDelete(null);
      await refresh();
    } catch (err) {
      setPendingDelete(null);
      setError(`Не удалось удалить: ${(err as Error).message}`);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <PageContainer width="wide">
      <PageHeader
        title="Источники банов"
        subtitle="Подписки на внешние банлисты сообществ. Синхронизация импортирует записи в общую сеть банов."
      />

      {error ? (
        <InlineBanner
          tone="crit"
          title="Не удалось выполнить запрос"
          description={error}
          action={
            <Button size="sm" onClick={() => void refresh()}>
              Повторить
            </Button>
          }
        />
      ) : null}
      {sources && me && !canManage ? (
        <InlineBanner
          tone="info"
          title="Только просмотр"
          description="Для изменения источников нужно право на управление источниками банов."
        />
      ) : null}

      {!sources || !me ? (
        <Card>
          <Skeleton variant="card" count={3} label="Загрузка источников банов" />
        </Card>
      ) : (
        <>
          {canManage ? (
            <Card padding="none">
              <CardHeader title="Добавить источник" />
              <form onSubmit={createSource}>
                <CardBody className="space-y-3">
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    <FieldRow label="Имя" htmlFor={`${formId}-name`}>
                      <TextInput
                        id={`${formId}-name`}
                        type="text"
                        value={form.name}
                        onChange={(event) =>
                          setForm((prev) => ({ ...prev, name: event.target.value }))
                        }
                        placeholder="Ру-Баны (collabans)"
                      />
                    </FieldRow>
                    <FieldRow label="URL банлиста" htmlFor={`${formId}-url`}>
                      <TextInput
                        id={`${formId}-url`}
                        type="url"
                        value={form.url}
                        onChange={(event) =>
                          setForm((prev) => ({ ...prev, url: event.target.value }))
                        }
                        placeholder="https://example.com/bans.cfg"
                      />
                    </FieldRow>
                    <FieldRow label="Формат" htmlFor={`${formId}-format`}>
                      <Select
                        id={`${formId}-format`}
                        value={form.format}
                        onChange={(event) =>
                          setForm((prev) => ({ ...prev, format: event.target.value }))
                        }
                      >
                        {FORMAT_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </Select>
                    </FieldRow>
                    <FieldRow label="Уровень доверия" htmlFor={`${formId}-trust`}>
                      <Select
                        id={`${formId}-trust`}
                        value={form.trust_level}
                        onChange={(event) =>
                          setForm((prev) => ({ ...prev, trust_level: event.target.value }))
                        }
                      >
                        {TRUST_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </Select>
                    </FieldRow>
                    <FieldRow label="Discord (необязательно)" htmlFor={`${formId}-discord`}>
                      <TextInput
                        id={`${formId}-discord`}
                        type="url"
                        value={form.discord_url}
                        onChange={(event) =>
                          setForm((prev) => ({ ...prev, discord_url: event.target.value }))
                        }
                        placeholder="https://discord.gg/…"
                      />
                    </FieldRow>
                    <FieldRow label="Действие при совпадении" htmlFor={`${formId}-on-match`}>
                      <Select
                        id={`${formId}-on-match`}
                        value={form.on_match}
                        onChange={(event) =>
                          setForm((prev) => ({ ...prev, on_match: event.target.value }))
                        }
                      >
                        {ON_MATCH_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </Select>
                    </FieldRow>
                    <FieldRow
                      label="Интервал опроса (мин)"
                      htmlFor={`${formId}-interval`}
                      hint="Не чаще одного раза в 15 минут."
                    >
                      <TextInput
                        id={`${formId}-interval`}
                        type="number"
                        min={15}
                        value={form.poll_interval_minutes}
                        onChange={(event) =>
                          setForm((prev) => ({
                            ...prev,
                            poll_interval_minutes: Number(event.target.value) || 60,
                          }))
                        }
                      />
                    </FieldRow>
                  </div>
                  <FieldRow
                    label="Auth-заголовок"
                    htmlFor={`${formId}-auth`}
                    hint="Секрет: хранится зашифрованным и больше не отображается."
                  >
                    <TextInput
                      id={`${formId}-auth`}
                      type="password"
                      value={form.auth_header}
                      onChange={(event) =>
                        setForm((prev) => ({ ...prev, auth_header: event.target.value }))
                      }
                      placeholder="Bearer …"
                      autoComplete="new-password"
                    />
                  </FieldRow>
                </CardBody>
                <CardFooter>
                  <Button type="submit" variant="primary" loading={creating}>
                    Добавить источник
                  </Button>
                </CardFooter>
              </form>
            </Card>
          ) : null}

          {sources.length === 0 ? (
            <Card padding="none">
              <EmptyState
                title="Источников пока нет"
                description="Подпишитесь на внешний банлист — записи начнут импортироваться по расписанию."
              />
            </Card>
          ) : (
            sources.map((source) => (
              <Card key={source.id} padding="none" as="section">
                <CardHeader
                  title={source.name}
                  actions={
                    canManage ? (
                      <>
                        <Button
                          size="sm"
                          loading={busyId === source.id}
                          onClick={() => void syncNow(source)}
                        >
                          Синхронизировать
                        </Button>
                        <IconButton
                          icon={<TrashIcon />}
                          label={`Удалить источник ${source.name}`}
                          tone="destructive"
                          disabled={busyId === source.id}
                          onClick={() => setPendingDelete(source)}
                        />
                      </>
                    ) : null
                  }
                />
                <CardBody className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={TRUST_TONE[source.trust_level] ?? 'accent'}>
                      Доверие: {trustLabel(source.trust_level)}
                    </Badge>
                    <Badge>{formatLabel(source.format)}</Badge>
                    <Badge>
                      {ON_MATCH_OPTIONS.find((option) => option.value === source.on_match)?.label ??
                        source.on_match}
                    </Badge>
                    {source.has_auth_header ? (
                      <Badge title="Настроен приватный auth-заголовок">Auth-заголовок</Badge>
                    ) : null}
                  </div>

                  <p className="break-all font-mono text-xs text-ink-3">{source.url}</p>

                  {source.discord_url ? (
                    <a
                      href={source.discord_url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-block text-xs text-accent no-underline hover:brightness-110"
                    >
                      Discord сообщества
                    </a>
                  ) : null}

                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <SourceStat
                      label="Записей"
                      value={<span className="tabular-nums">{source.record_count}</span>}
                    />
                    <SourceStat
                      label="Интервал"
                      value={
                        <span className="tabular-nums">{source.poll_interval_minutes} мин</span>
                      }
                    />
                    <SourceStat
                      label="Последняя синхронизация"
                      value={formatDate(source.last_sync_at)}
                    />
                    <SourceStat
                      label="Состояние"
                      value={
                        source.last_sync_status === 'error' ? (
                          <Badge tone="crit">ошибка</Badge>
                        ) : source.last_sync_status === 'ok' ? (
                          <Badge tone="good">успешно</Badge>
                        ) : (
                          <span className="text-ink-3">—</span>
                        )
                      }
                    />
                  </div>

                  {source.last_sync_status === 'error' && source.last_sync_error ? (
                    <InlineBanner
                      tone="crit"
                      title="Последняя синхронизация не удалась"
                      description={
                        <span className="break-all font-mono">{source.last_sync_error}</span>
                      }
                    />
                  ) : null}
                </CardBody>
                <CardFooter>
                  <span className="mr-auto text-xs text-ink-3">
                    {source.enabled ? 'Активен — опрашивается по расписанию' : 'Выключен'}
                  </span>
                  <Switch
                    label={`Включить источник ${source.name}`}
                    checked={source.enabled}
                    disabled={!canManage || busyId === source.id}
                    onChange={() => void toggleEnabled(source)}
                  />
                </CardFooter>
              </Card>
            ))
          )}
        </>
      )}

      <PublicationSection />

      <AlertDialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        title="Удалить источник банов"
        body={
          <>
            Источник «{pendingDelete?.name}» и все импортированные из него баны будут удалены
            безвозвратно. Восстановить их можно только повторной синхронизацией с внешним списком.
          </>
        }
        confirmLabel="Удалить источник"
        cancelLabel="Отмена"
        tone="destructive"
        busy={pendingDelete !== null && busyId === pendingDelete.id}
        challenge={
          pendingDelete
            ? {
                expected: pendingDelete.name,
                label: 'Повторите имя источника',
                hint: pendingDelete.name,
              }
            : undefined
        }
        onConfirm={() => {
          if (pendingDelete) void removeSource(pendingDelete);
        }}
      />
    </PageContainer>
  );
}
