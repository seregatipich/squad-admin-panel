'use client';
import { useEffect, useState } from 'react';
import {
  AlertDialog,
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  Checkbox,
  EmptyState,
  FieldRow,
  IconButton,
  InlineBanner,
  PageHeader,
  Select,
  Skeleton,
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
import DiscordRoleMappingsSection from './DiscordRoleMappingsSection';
import DiscordStatusChannelsSection from './DiscordStatusChannelsSection';
import DiscordTemplatesSection from './DiscordTemplatesSection';
import {
  DISCORD_EVENT_TYPES,
  type DiscordEventType,
  describeTestSendOutcome,
  eventLabel,
  looksLikeWebhookUrl,
  type TestSendOutcome,
} from './discord-events';

const POLL_MS = 60_000;

interface IntegrationSettings {
  guild_id: string | null;
  enabled: boolean;
  bot_token_configured: boolean;
  bot_token_mask: string | null;
  updated_at: string | null;
}

interface WebhookRow {
  id: string;
  event_type: string;
  channel_label: string | null;
  enabled: boolean;
  mention_everyone: boolean;
  server_id: string | null;
  url_configured: boolean;
  url_mask: string;
  created_at: string;
  updated_at: string;
}

type Banner = { kind: 'ok' | 'err'; text: string } | null;

async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    throw new Error(`HTTP ${res.status}: ${body.error ?? 'unknown'}`);
  }
  return (await res.json()) as T;
}

export default function DiscordIntegrationPage() {
  const [integration, setIntegration] = useState<IntegrationSettings | null>(null);
  const [webhooks, setWebhooks] = useState<WebhookRow[]>([]);
  const [guildId, setGuildId] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [botToken, setBotToken] = useState('');
  const [savingIntegration, setSavingIntegration] = useState(false);

  const [newEventType, setNewEventType] = useState<DiscordEventType>('ban_issued');
  const [newUrl, setNewUrl] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [newMention, setNewMention] = useState(false);
  const [creating, setCreating] = useState(false);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, TestSendOutcome>>({});
  const [banner, setBanner] = useState<Banner>(null);
  const [forbidden, setForbidden] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<WebhookRow | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [settingsRes, hooksRes] = await Promise.all([
          fetch('/api/v1/integrations/discord', { credentials: 'include', cache: 'no-store' }),
          fetch('/api/v1/integrations/discord/webhooks', {
            credentials: 'include',
            cache: 'no-store',
          }),
        ]);
        if (cancelled) return;
        if (settingsRes.status === 403 || hooksRes.status === 403) {
          setForbidden(true);
          return;
        }
        const settings = await readJson<IntegrationSettings>(settingsRes);
        const hooks = await readJson<WebhookRow[]>(hooksRes);
        if (cancelled) return;
        setIntegration(settings);
        setGuildId(settings.guild_id ?? '');
        setEnabled(settings.enabled);
        setWebhooks(hooks);
      } catch (e) {
        if (!cancelled) setBanner({ kind: 'err', text: (e as Error).message });
      }
    }
    void load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  async function saveIntegration(e: React.FormEvent) {
    e.preventDefault();
    setSavingIntegration(true);
    setBanner(null);
    try {
      const payload: Record<string, unknown> = {
        guild_id: guildId.trim() === '' ? null : guildId.trim(),
        enabled,
      };
      if (botToken.trim() !== '') payload.bot_token = botToken.trim();
      const res = await fetch('/api/v1/integrations/discord', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const updated = await readJson<IntegrationSettings>(res);
      setIntegration(updated);
      setBotToken('');
      setBanner({ kind: 'ok', text: 'Настройки интеграции сохранены.' });
    } catch (err) {
      setBanner({ kind: 'err', text: (err as Error).message });
    } finally {
      setSavingIntegration(false);
    }
  }

  async function createWebhook(e: React.FormEvent) {
    e.preventDefault();
    if (!looksLikeWebhookUrl(newUrl)) {
      setBanner({ kind: 'err', text: 'Укажите корректный Discord webhook URL.' });
      return;
    }
    setCreating(true);
    setBanner(null);
    try {
      const res = await fetch('/api/v1/integrations/discord/webhooks', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          event_type: newEventType,
          webhook_url: newUrl.trim(),
          channel_label: newLabel.trim() === '' ? null : newLabel.trim(),
          mention_everyone: newMention,
        }),
      });
      const created = await readJson<WebhookRow>(res);
      setWebhooks((prev) => [...prev, created]);
      setNewUrl('');
      setNewLabel('');
      setNewMention(false);
      setBanner({ kind: 'ok', text: 'Вебхук добавлен.' });
    } catch (err) {
      setBanner({ kind: 'err', text: (err as Error).message });
    } finally {
      setCreating(false);
    }
  }

  async function toggleWebhook(row: WebhookRow) {
    setBusyId(row.id);
    setBanner(null);
    try {
      const res = await fetch(`/api/v1/integrations/discord/webhooks/${row.id}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: !row.enabled }),
      });
      const updated = await readJson<WebhookRow>(res);
      setWebhooks((prev) => prev.map((w) => (w.id === row.id ? updated : w)));
    } catch (err) {
      setBanner({ kind: 'err', text: (err as Error).message });
    } finally {
      setBusyId(null);
    }
  }

  async function deleteWebhook(id: string) {
    setBusyId(id);
    setBanner(null);
    try {
      const res = await fetch(`/api/v1/integrations/discord/webhooks/${id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setWebhooks((prev) => prev.filter((w) => w.id !== id));
      setBanner({ kind: 'ok', text: 'Вебхук удалён.' });
    } catch (err) {
      setBanner({ kind: 'err', text: (err as Error).message });
    } finally {
      setBusyId(null);
      setPendingDelete(null);
    }
  }

  async function testWebhook(id: string) {
    setTestingId(id);
    setTestResults((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    try {
      const res = await fetch(`/api/v1/integrations/discord/webhooks/${id}/test`, {
        method: 'POST',
        credentials: 'include',
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; status?: number };
      setTestResults((prev) => ({ ...prev, [id]: describeTestSendOutcome(res.ok, body) }));
    } catch {
      setTestResults((prev) => ({
        ...prev,
        [id]: { kind: 'err', text: 'Сетевая ошибка при отправке.' },
      }));
    } finally {
      setTestingId(null);
    }
  }

  if (forbidden) {
    return (
      <InlineBanner
        tone="warn"
        title="Недостаточно прав"
        description="Для управления интеграциями нужен доступ «Управлять интеграциями»."
      />
    );
  }

  return (
    <>
      <PageHeader
        title="Discord-интеграция"
        subtitle="Настройте бота и вебхуки для уведомлений о событиях серверов. Токен бота и URL вебхуков хранятся в зашифрованном виде и никогда не показываются целиком — только маска."
      />

      {banner ? (
        <InlineBanner tone={banner.kind === 'ok' ? 'good' : 'crit'} title={banner.text} />
      ) : null}

      {!integration ? (
        <Card>
          <Skeleton variant="row" count={4} label="Загрузка настроек Discord" />
        </Card>
      ) : (
        <>
          <Card padding="none" as="section">
            <CardHeader title="Бот и сервер Discord" />
            <form onSubmit={saveIntegration}>
              <CardBody className="space-y-4">
                <FieldRow label="Guild ID">
                  <TextInput
                    value={guildId}
                    onChange={(e) => setGuildId(e.target.value)}
                    inputMode="numeric"
                    placeholder="напр. 123456789012345678"
                  />
                </FieldRow>
                <FieldRow
                  label="Токен бота"
                  hint={
                    integration.bot_token_configured ? (
                      <>
                        Задан: <span className="font-mono">{integration.bot_token_mask}</span>.
                        Оставьте поле пустым, чтобы не менять.
                      </>
                    ) : (
                      'Токен ещё не задан.'
                    )
                  }
                >
                  <TextInput
                    type="password"
                    value={botToken}
                    onChange={(e) => setBotToken(e.target.value)}
                    autoComplete="new-password"
                    placeholder={
                      integration.bot_token_configured
                        ? 'Оставьте пустым, чтобы не менять'
                        : 'Вставьте токен бота'
                    }
                  />
                </FieldRow>
                <Checkbox
                  label="Интеграция включена"
                  checked={enabled}
                  onChange={(e) => setEnabled(e.target.checked)}
                />
              </CardBody>
              <CardFooter>
                <Button type="submit" variant="primary" loading={savingIntegration}>
                  Сохранить
                </Button>
              </CardFooter>
            </form>
          </Card>

          <Card padding="none" as="section">
            <CardHeader title="Добавить вебхук" />
            <form onSubmit={createWebhook}>
              <CardBody className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <FieldRow label="Тип события">
                    <Select
                      value={newEventType}
                      onChange={(e) => setNewEventType(e.target.value as DiscordEventType)}
                    >
                      {DISCORD_EVENT_TYPES.map((type) => (
                        <option key={type} value={type}>
                          {eventLabel(type)}
                        </option>
                      ))}
                    </Select>
                  </FieldRow>
                  <FieldRow label="Метка канала">
                    <TextInput
                      value={newLabel}
                      onChange={(e) => setNewLabel(e.target.value)}
                      maxLength={100}
                      placeholder="напр. #bans"
                    />
                  </FieldRow>
                </div>
                <FieldRow
                  label="Webhook URL"
                  hint="Записывается, но никогда не показывается целиком."
                >
                  <TextInput
                    type="password"
                    className="font-mono"
                    value={newUrl}
                    onChange={(e) => setNewUrl(e.target.value)}
                    autoComplete="off"
                    placeholder="https://discord.com/api/webhooks/…"
                  />
                </FieldRow>
                <Checkbox
                  label="Упоминать @everyone"
                  checked={newMention}
                  onChange={(e) => setNewMention(e.target.checked)}
                />
              </CardBody>
              <CardFooter>
                <Button type="submit" variant="primary" loading={creating}>
                  Добавить вебхук
                </Button>
              </CardFooter>
            </form>
          </Card>

          <Card padding="none" as="section">
            <CardHeader title="Вебхуки" count={webhooks.length > 0 ? webhooks.length : undefined} />
            {webhooks.length === 0 ? (
              <EmptyState
                title="Вебхуков пока нет"
                description="Добавьте первый вебхук формой выше — до этого события никуда не уходят."
              />
            ) : (
              <Table ariaLabel="Вебхуки Discord">
                <TableHead>
                  <tr>
                    <Th>Событие</Th>
                    <Th>Канал</Th>
                    <Th>URL</Th>
                    <Th>@everyone</Th>
                    <Th>Состояние</Th>
                    <Th>Проверка</Th>
                    <Th align="right">Действия</Th>
                  </tr>
                </TableHead>
                <TableBody>
                  {webhooks.map((row) => (
                    <TableRow key={row.id}>
                      <Td>{eventLabel(row.event_type)}</Td>
                      <Td className="text-ink-2">{row.channel_label ?? '—'}</Td>
                      <Td className="font-mono text-2xs text-ink-3">{row.url_mask}</Td>
                      <Td className="text-ink-2">{row.mention_everyone ? 'да' : '—'}</Td>
                      <Td>
                        <span className="flex items-center gap-2">
                          <span className="text-xs text-ink-3">{row.enabled ? 'Вкл' : 'Выкл'}</span>
                          <Switch
                            label={`Включить вебхук «${eventLabel(row.event_type)}»`}
                            checked={row.enabled}
                            disabled={busyId === row.id}
                            onChange={() => void toggleWebhook(row)}
                          />
                        </span>
                      </Td>
                      <Td>
                        <div className="flex flex-col items-start gap-1">
                          <Button
                            size="sm"
                            loading={testingId === row.id}
                            onClick={() => void testWebhook(row.id)}
                          >
                            Тест
                          </Button>
                          {testResults[row.id] ? (
                            <span
                              className={
                                testResults[row.id]?.kind === 'ok'
                                  ? 'text-2xs text-good'
                                  : 'text-2xs text-crit'
                              }
                            >
                              {testResults[row.id]?.text}
                            </span>
                          ) : null}
                        </div>
                      </Td>
                      <Td align="right">
                        <IconButton
                          icon={<TrashIcon />}
                          label={`Удалить вебхук «${eventLabel(row.event_type)}»`}
                          size="sm"
                          tone="destructive"
                          disabled={busyId === row.id}
                          onClick={() => setPendingDelete(row)}
                        />
                      </Td>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Card>
        </>
      )}

      <DiscordTemplatesSection />
      <DiscordRoleMappingsSection />
      <DiscordStatusChannelsSection />

      <AlertDialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        title="Удалить вебхук"
        body={
          pendingDelete
            ? `Вебхук «${eventLabel(pendingDelete.event_type)}»${pendingDelete.channel_label ? ` (${pendingDelete.channel_label})` : ''} будет удалён вместе с сохранённым адресом. Уведомления по этому событию перестанут уходить.`
            : ''
        }
        confirmLabel="Удалить вебхук"
        cancelLabel="Отмена"
        tone="destructive"
        busy={pendingDelete !== null && busyId === pendingDelete.id}
        onConfirm={() => {
          if (pendingDelete) void deleteWebhook(pendingDelete.id);
        }}
      />
    </>
  );
}
