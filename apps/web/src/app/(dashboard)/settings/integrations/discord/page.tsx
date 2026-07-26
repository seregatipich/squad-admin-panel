'use client';
import { useEffect, useId, useState } from 'react';
import { LiveIndicator } from '@/components/LiveIndicator';
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
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const guildInputId = useId();
  const botInputId = useId();
  const urlInputId = useId();

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
        setLastUpdate(new Date());
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
    if (!confirm('Удалить вебхук?')) return;
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
      <div className="max-w-2xl rounded border border-red-900 bg-red-950 p-4 text-sm text-red-200">
        Недостаточно прав. Для управления интеграциями нужен доступ «Управлять интеграциями».
      </div>
    );
  }

  if (!integration) {
    return <div className="text-neutral-500">Загрузка…</div>;
  }

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Discord-интеграция</h1>
        <LiveIndicator lastUpdate={lastUpdate} />
      </div>

      <p className="text-sm text-neutral-400">
        Настройте бота и вебхуки для уведомлений о событиях серверов. Токен бота и URL вебхуков
        хранятся в зашифрованном виде и никогда не показываются целиком — только маска.
      </p>

      {banner ? (
        <div
          className={`rounded border p-3 text-sm ${
            banner.kind === 'ok'
              ? 'border-emerald-900 bg-emerald-950/50 text-emerald-200'
              : 'border-red-900 bg-red-950 text-red-200'
          }`}
        >
          {banner.text}
        </div>
      ) : null}

      <section className="space-y-3 rounded border border-neutral-800 bg-neutral-950 p-4">
        <h2 className="text-xs uppercase tracking-widest text-neutral-400">Бот и сервер Discord</h2>
        <form onSubmit={saveIntegration} className="space-y-3">
          <div>
            <label htmlFor={guildInputId} className="mb-1 block text-xs text-neutral-500">
              Guild ID
            </label>
            <input
              id={guildInputId}
              type="text"
              value={guildId}
              onChange={(e) => setGuildId(e.target.value)}
              inputMode="numeric"
              placeholder="напр. 123456789012345678"
              className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm focus:border-neutral-600 focus:outline-none"
            />
          </div>
          <div>
            <label htmlFor={botInputId} className="mb-1 block text-xs text-neutral-500">
              Токен бота{' '}
              {integration.bot_token_configured ? (
                <span className="ml-1 rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-[10px] text-neutral-300">
                  задан: {integration.bot_token_mask}
                </span>
              ) : (
                <span className="ml-1 text-neutral-600">не задан</span>
              )}
            </label>
            <input
              id={botInputId}
              type="password"
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
              autoComplete="new-password"
              placeholder={
                integration.bot_token_configured
                  ? 'Оставьте пустым, чтобы не менять'
                  : 'Вставьте токен бота'
              }
              className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm focus:border-neutral-600 focus:outline-none"
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-neutral-300">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            Интеграция включена
          </label>
          <button
            type="submit"
            disabled={savingIntegration}
            className="rounded border border-emerald-900 px-4 py-1.5 text-sm text-emerald-300 hover:border-emerald-700 disabled:opacity-40"
          >
            {savingIntegration ? 'Сохранение…' : 'Сохранить'}
          </button>
        </form>
      </section>

      <section className="space-y-3 rounded border border-neutral-800 bg-neutral-950 p-4">
        <h2 className="text-xs uppercase tracking-widest text-neutral-400">Добавить вебхук</h2>
        <form onSubmit={createWebhook} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor={`${urlInputId}-type`} className="mb-1 block text-xs text-neutral-500">
                Тип события
              </label>
              <select
                id={`${urlInputId}-type`}
                value={newEventType}
                onChange={(e) => setNewEventType(e.target.value as DiscordEventType)}
                className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm focus:border-neutral-600 focus:outline-none"
              >
                {DISCORD_EVENT_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {eventLabel(type)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label
                htmlFor={`${urlInputId}-label`}
                className="mb-1 block text-xs text-neutral-500"
              >
                Метка канала
              </label>
              <input
                id={`${urlInputId}-label`}
                type="text"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                maxLength={100}
                placeholder="напр. #bans"
                className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm focus:border-neutral-600 focus:outline-none"
              />
            </div>
          </div>
          <div>
            <label htmlFor={urlInputId} className="mb-1 block text-xs text-neutral-500">
              Webhook URL (только запись)
            </label>
            <input
              id={urlInputId}
              type="password"
              value={newUrl}
              onChange={(e) => setNewUrl(e.target.value)}
              autoComplete="off"
              placeholder="https://discord.com/api/webhooks/…"
              className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 font-mono text-xs focus:border-neutral-600 focus:outline-none"
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-neutral-300">
            <input
              type="checkbox"
              checked={newMention}
              onChange={(e) => setNewMention(e.target.checked)}
            />
            Упоминать @everyone
          </label>
          <button
            type="submit"
            disabled={creating}
            className="rounded border border-emerald-900 px-4 py-1.5 text-sm text-emerald-300 hover:border-emerald-700 disabled:opacity-40"
          >
            {creating ? 'Добавление…' : 'Добавить вебхук'}
          </button>
        </form>
      </section>

      <section className="space-y-3 rounded border border-neutral-800 bg-neutral-950 p-4">
        <h2 className="text-xs uppercase tracking-widest text-neutral-400">Вебхуки</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-neutral-500">
              <tr>
                <th className="py-2 pr-2">Событие</th>
                <th className="py-2 pr-2">Канал</th>
                <th className="py-2 pr-2">URL</th>
                <th className="py-2 pr-2">@everyone</th>
                <th className="py-2 pr-2">Статус</th>
                <th className="py-2 pr-2">Тест</th>
                <th className="py-2 pr-2"></th>
              </tr>
            </thead>
            <tbody>
              {webhooks.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-3 text-center text-xs text-neutral-500">
                    Вебхуков пока нет.
                  </td>
                </tr>
              ) : (
                webhooks.map((row) => (
                  <tr key={row.id} className="border-t border-neutral-900 align-top">
                    <td className="py-2 pr-2">{eventLabel(row.event_type)}</td>
                    <td className="py-2 pr-2 text-neutral-400">{row.channel_label ?? '—'}</td>
                    <td className="py-2 pr-2 font-mono text-[10px] text-neutral-400">
                      {row.url_mask}
                    </td>
                    <td className="py-2 pr-2 text-neutral-400">
                      {row.mention_everyone ? 'да' : '—'}
                    </td>
                    <td className="py-2 pr-2">
                      <button
                        type="button"
                        disabled={busyId === row.id}
                        onClick={() => toggleWebhook(row)}
                        className={`rounded px-2 py-0.5 text-xs disabled:opacity-40 ${
                          row.enabled
                            ? 'bg-emerald-950/50 text-emerald-300'
                            : 'bg-neutral-800 text-neutral-400'
                        }`}
                      >
                        {row.enabled ? 'вкл' : 'выкл'}
                      </button>
                    </td>
                    <td className="py-2 pr-2">
                      <div className="flex flex-col items-start gap-1">
                        <button
                          type="button"
                          disabled={testingId === row.id}
                          onClick={() => testWebhook(row.id)}
                          className="rounded border border-sky-900 px-3 py-0.5 text-xs text-sky-300 hover:border-sky-700 disabled:opacity-40"
                        >
                          {testingId === row.id ? 'Отправка…' : 'Тест'}
                        </button>
                        {testResults[row.id] ? (
                          <span
                            className={`text-[11px] ${
                              testResults[row.id]?.kind === 'ok'
                                ? 'text-emerald-400'
                                : 'text-red-400'
                            }`}
                          >
                            {testResults[row.id]?.text}
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="py-2 pr-2 text-right">
                      <button
                        type="button"
                        disabled={busyId === row.id}
                        onClick={() => deleteWebhook(row.id)}
                        className="rounded border border-red-900 px-3 py-0.5 text-xs text-red-400 hover:border-red-700 disabled:opacity-40"
                      >
                        Удалить
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
      <DiscordTemplatesSection />
    </div>
  );
}
