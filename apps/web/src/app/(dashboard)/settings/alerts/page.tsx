'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  AlertDialog,
  Badge,
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  Checkbox,
  EmptyState,
  FieldRow,
  GroupedRow,
  IconButton,
  InlineBanner,
  PageHeader,
  Select,
  Skeleton,
  SkeletonTable,
  Switch,
  Table,
  TableBody,
  TableHead,
  TableRow,
  Td,
  TextInput,
  Th,
  TrashIcon,
} from '@/components/ui';

interface AlertRule {
  id: string;
  name: string;
  type: string;
  config: Record<string, unknown>;
  channels: string[];
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

interface AlertEvent {
  id: string;
  rule_id: string;
  rule_name: string | null;
  rule_type: string | null;
  triggered_at: string;
  payload: Record<string, unknown>;
  severity: string;
  delivered: boolean;
}

interface Me {
  permissions: string[];
}

const TYPE_OPTIONS: ReadonlyArray<{ value: string; label: string; hint: string }> = [
  {
    value: 'server_crashed',
    label: 'Падение сервера',
    hint: 'Срабатывает на событие server.crashed.',
  },
  {
    value: 'unusual_activity',
    label: 'Аномальная активность',
    hint: 'N подключений за окно из M минут.',
  },
  {
    value: 'admin_login_new_ip',
    label: 'Вход админа с нового IP',
    hint: 'Админ панели подключается с IP, которого нет в его истории.',
  },
  { value: 'custom', label: 'Своё правило', hint: 'Условие по типу события и порогу.' },
];

const CHANNEL_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'email', label: 'Email' },
  { value: 'webpush', label: 'Web Push' },
];

/** Важность срабатывания: тон подложки и русская подпись, которая его дублирует (§5). */
const SEVERITY: Record<string, { tone: 'crit' | 'warn' | 'accent'; label: string }> = {
  critical: { tone: 'crit', label: 'Критично' },
  warning: { tone: 'warn', label: 'Предупреждение' },
  info: { tone: 'accent', label: 'Информация' },
};

function severityBadge(severity: string) {
  return SEVERITY[severity] ?? { tone: 'accent' as const, label: severity };
}

function channelLabel(channel: string): string {
  return CHANNEL_OPTIONS.find((option) => option.value === channel)?.label ?? channel;
}

// Read-only labels for rule types that exist but are not creatable through
// the form (system-seeded, e.g. VIPSUB-4's role_expiring) — deliberately kept
// out of TYPE_OPTIONS.
const READONLY_TYPE_LABELS: Record<string, string> = {
  role_expiring: 'Истечение VIP',
};

function typeLabel(type: string): string {
  return (
    TYPE_OPTIONS.find((option) => option.value === type)?.label ??
    READONLY_TYPE_LABELS[type] ??
    type
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU');
}

const EMPTY_FORM = {
  name: '',
  type: 'server_crashed',
  channels: ['email'] as string[],
  windowMinutes: 5,
  connectThreshold: 20,
  eventKind: '',
  threshold: 0,
};

function buildConfig(form: typeof EMPTY_FORM): Record<string, unknown> {
  if (form.type === 'unusual_activity') {
    return { windowMinutes: form.windowMinutes, connectThreshold: form.connectThreshold };
  }
  if (form.type === 'custom') {
    const config: Record<string, unknown> = { eventKind: form.eventKind.trim() };
    if (form.threshold > 0) config.threshold = form.threshold;
    return config;
  }
  return {};
}

export default function AlertsPage() {
  const [rules, setRules] = useState<AlertRule[] | null>(null);
  const [events, setEvents] = useState<AlertEvent[] | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AlertRule | null>(null);

  const refresh = useCallback(async () => {
    const [rulesRes, eventsRes, meRes] = await Promise.all([
      fetch('/api/v1/alert-rules', { credentials: 'include', cache: 'no-store' }),
      fetch('/api/v1/alerts', { credentials: 'include', cache: 'no-store' }),
      fetch('/api/v1/me', { credentials: 'include', cache: 'no-store' }),
    ]);
    if (rulesRes.ok) setRules((await rulesRes.json()) as AlertRule[]);
    if (eventsRes.ok) setEvents((await eventsRes.json()) as AlertEvent[]);
    if (meRes.ok) setMe((await meRes.json()) as Me);
    setLoadFailed(!rulesRes.ok || !eventsRes.ok || !meRes.ok);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const canManage = me?.permissions.includes('role:edit') ?? false;

  function toggleChannel(channel: string) {
    setForm((prev) => ({
      ...prev,
      channels: prev.channels.includes(channel)
        ? prev.channels.filter((entry) => entry !== channel)
        : [...prev.channels, channel],
    }));
  }

  async function createRule(event: React.FormEvent) {
    event.preventDefault();
    if (!form.name.trim()) {
      setError('Укажите имя правила.');
      return;
    }
    if (form.type === 'custom' && !form.eventKind.trim()) {
      setError('Для своего правила укажите тип события (eventKind).');
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const res = await fetch('/api/v1/alert-rules', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: form.name.trim(),
          type: form.type,
          config: buildConfig(form),
          channels: form.channels,
          enabled: true,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        throw new Error(String(body.error ?? res.status));
      }
      setForm({ ...EMPTY_FORM });
      await refresh();
    } catch (err) {
      setError(`Не удалось создать правило: ${(err as Error).message}`);
    } finally {
      setCreating(false);
    }
  }

  async function toggleEnabled(rule: AlertRule) {
    if (!canManage) return;
    setBusyId(rule.id);
    setError(null);
    try {
      const res = await fetch(`/api/v1/alert-rules/${rule.id}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: !rule.enabled }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await refresh();
    } catch (err) {
      setError(`Не удалось изменить статус: ${(err as Error).message}`);
    } finally {
      setBusyId(null);
    }
  }

  async function removeRule(rule: AlertRule) {
    if (!canManage) return;
    setBusyId(rule.id);
    setError(null);
    try {
      const res = await fetch(`/api/v1/alert-rules/${rule.id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await refresh();
    } catch (err) {
      setError(`Не удалось удалить: ${(err as Error).message}`);
    } finally {
      setBusyId(null);
      setPendingDelete(null);
    }
  }

  const loading = !rules || !events || !me;
  const selectedType = TYPE_OPTIONS.find((option) => option.value === form.type);

  return (
    <>
      <PageHeader
        title="Оповещения"
        subtitle="Правила оповещений о падении сервера, аномальной активности и входе админов с нового IP. Доставка по Email и Web Push включается ключами окружения; без них срабатывания записываются в историю без отправки."
      />

      {!loading && !canManage ? (
        <InlineBanner
          tone="info"
          title="Только просмотр"
          description="У вас нет прав на изменение правил оповещений."
        />
      ) : null}

      {loadFailed ? (
        <InlineBanner
          tone="crit"
          title="Не удалось загрузить оповещения"
          description="Часть данных не пришла — список правил или история могут быть неполными."
          action={
            <Button size="sm" onClick={() => void refresh()}>
              Повторить
            </Button>
          }
        />
      ) : null}

      {error ? <InlineBanner tone="crit" title={error} /> : null}

      {loading ? (
        <>
          <Card>
            <Skeleton variant="row" count={3} label="Загрузка правил оповещений" />
          </Card>
          <Card padding="sm">
            <SkeletonTable rows={4} cols={5} />
          </Card>
        </>
      ) : (
        <>
          {canManage ? (
            <Card padding="none" as="section">
              <CardHeader title="Добавить правило" />
              <form onSubmit={createRule}>
                <CardBody className="space-y-4">
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    <FieldRow label="Имя">
                      <TextInput
                        value={form.name}
                        onChange={(event) =>
                          setForm((prev) => ({ ...prev, name: event.target.value }))
                        }
                        placeholder="Падение боевого сервера"
                      />
                    </FieldRow>
                    <FieldRow label="Тип" hint={selectedType?.hint}>
                      <Select
                        value={form.type}
                        onChange={(event) =>
                          setForm((prev) => ({ ...prev, type: event.target.value }))
                        }
                      >
                        {TYPE_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </Select>
                    </FieldRow>
                  </div>

                  {form.type === 'unusual_activity' ? (
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                      <FieldRow label="Окно, мин">
                        <TextInput
                          type="number"
                          min={1}
                          value={form.windowMinutes}
                          onChange={(event) =>
                            setForm((prev) => ({
                              ...prev,
                              windowMinutes: Number(event.target.value) || 1,
                            }))
                          }
                        />
                      </FieldRow>
                      <FieldRow label="Порог подключений">
                        <TextInput
                          type="number"
                          min={1}
                          value={form.connectThreshold}
                          onChange={(event) =>
                            setForm((prev) => ({
                              ...prev,
                              connectThreshold: Number(event.target.value) || 1,
                            }))
                          }
                        />
                      </FieldRow>
                    </div>
                  ) : null}

                  {form.type === 'custom' ? (
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                      <FieldRow label="Тип события (eventKind)">
                        <TextInput
                          value={form.eventKind}
                          onChange={(event) =>
                            setForm((prev) => ({ ...prev, eventKind: event.target.value }))
                          }
                          placeholder="rcon.disconnected"
                        />
                      </FieldRow>
                      <FieldRow label="Порог" hint="0 — без порога.">
                        <TextInput
                          type="number"
                          min={0}
                          value={form.threshold}
                          onChange={(event) =>
                            setForm((prev) => ({
                              ...prev,
                              threshold: Number(event.target.value) || 0,
                            }))
                          }
                        />
                      </FieldRow>
                    </div>
                  ) : null}

                  <fieldset className="space-y-1">
                    <legend className="text-xs font-medium text-ink-2">Каналы доставки</legend>
                    <div className="flex flex-wrap gap-4">
                      {CHANNEL_OPTIONS.map((option) => (
                        <Checkbox
                          key={option.value}
                          label={option.label}
                          checked={form.channels.includes(option.value)}
                          onChange={() => toggleChannel(option.value)}
                        />
                      ))}
                    </div>
                  </fieldset>
                </CardBody>
                <CardFooter>
                  <Button type="submit" variant="primary" loading={creating}>
                    Добавить правило
                  </Button>
                </CardFooter>
              </form>
            </Card>
          ) : null}

          <Card padding="none" as="section">
            <CardHeader title="Правила" count={rules.length > 0 ? rules.length : undefined} />
            {rules.length === 0 ? (
              <EmptyState
                title="Правил пока нет"
                description={
                  canManage
                    ? 'Добавьте первое правило формой выше — до этого срабатывания не записываются.'
                    : 'Правила добавляет администратор с правом изменения ролей.'
                }
              />
            ) : (
              <div className="divide-y divide-line">
                {rules.map((rule) => (
                  <GroupedRow
                    key={rule.id}
                    label={
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{rule.name}</span>
                        <Badge size="sm">{typeLabel(rule.type)}</Badge>
                        {rule.channels.map((channel) => (
                          <Badge key={channel} size="sm">
                            {channelLabel(channel)}
                          </Badge>
                        ))}
                      </span>
                    }
                    control={
                      <>
                        <span className="text-xs text-ink-3">
                          {rule.enabled ? 'Включено' : 'Выключено'}
                        </span>
                        <Switch
                          label={`Включить правило ${rule.name}`}
                          checked={rule.enabled}
                          disabled={!canManage || busyId === rule.id}
                          onChange={() => void toggleEnabled(rule)}
                        />
                        {canManage ? (
                          <IconButton
                            icon={<TrashIcon />}
                            label={`Удалить правило ${rule.name}`}
                            tone="destructive"
                            disabled={busyId === rule.id}
                            onClick={() => setPendingDelete(rule)}
                          />
                        ) : null}
                      </>
                    }
                  />
                ))}
              </div>
            )}
          </Card>

          <Card padding="none" as="section">
            <CardHeader
              title="История срабатываний"
              count={events.length > 0 ? events.length : undefined}
            />
            {events.length === 0 ? (
              <EmptyState
                title="Срабатываний пока нет"
                description="Здесь появятся события, поднятые правилами, — вместе с тем, ушло ли по ним оповещение."
              />
            ) : (
              <Table ariaLabel="История срабатываний правил">
                <TableHead>
                  <tr>
                    <Th>Время</Th>
                    <Th>Правило</Th>
                    <Th>Важность</Th>
                    <Th>Доставлено</Th>
                    <Th>Данные</Th>
                  </tr>
                </TableHead>
                <TableBody>
                  {events.map((event) => {
                    const severity = severityBadge(event.severity);
                    return (
                      <TableRow key={event.id}>
                        <Td className="whitespace-nowrap text-xs text-ink-2">
                          {formatDate(event.triggered_at)}
                        </Td>
                        <Td>
                          {event.rule_name ?? '—'}
                          {event.rule_type ? (
                            <span className="ml-1 text-xs text-ink-3">
                              ({typeLabel(event.rule_type)})
                            </span>
                          ) : null}
                        </Td>
                        <Td>
                          <Badge tone={severity.tone} size="sm">
                            {severity.label}
                          </Badge>
                        </Td>
                        <Td>
                          <Badge tone={event.delivered ? 'good' : 'neutral'} size="sm">
                            {event.delivered ? 'да' : 'нет'}
                          </Badge>
                        </Td>
                        <Td>
                          <code className="break-all font-mono text-2xs text-ink-3">
                            {JSON.stringify(event.payload)}
                          </code>
                        </Td>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </Card>
        </>
      )}

      <AlertDialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        title="Удалить правило"
        body={
          pendingDelete
            ? `Правило «${pendingDelete.name}» и вся его история срабатываний будут удалены без возможности восстановления.`
            : ''
        }
        confirmLabel="Удалить правило"
        cancelLabel="Отмена"
        tone="destructive"
        busy={pendingDelete !== null && busyId === pendingDelete.id}
        onConfirm={() => {
          if (pendingDelete) void removeRule(pendingDelete);
        }}
      />
    </>
  );
}
