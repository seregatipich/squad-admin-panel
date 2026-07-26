'use client';

import { useCallback, useEffect, useState } from 'react';

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

const SEVERITY_BADGE: Record<string, string> = {
  critical: 'border-red-800 bg-red-950/50 text-red-300',
  warning: 'border-amber-800 bg-amber-950/50 text-amber-300',
  info: 'border-sky-800 bg-sky-950/50 text-sky-300',
};

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
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [rulesRes, eventsRes, meRes] = await Promise.all([
      fetch('/api/v1/alert-rules', { credentials: 'include', cache: 'no-store' }),
      fetch('/api/v1/alerts', { credentials: 'include', cache: 'no-store' }),
      fetch('/api/v1/me', { credentials: 'include', cache: 'no-store' }),
    ]);
    if (rulesRes.ok) setRules((await rulesRes.json()) as AlertRule[]);
    if (eventsRes.ok) setEvents((await eventsRes.json()) as AlertEvent[]);
    if (meRes.ok) setMe((await meRes.json()) as Me);
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
    if (!confirm(`Удалить правило «${rule.name}» и всю его историю срабатываний?`)) return;
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
    }
  }

  if (!rules || !events || !me) return <div className="text-neutral-500">Загрузка…</div>;

  const selectedType = TYPE_OPTIONS.find((option) => option.value === form.type);

  return (
    <div className="max-w-4xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Оповещения</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Правила оповещений о падении сервера, аномальной активности и входе админов с нового IP.
          Доставка по Email и Web Push включается ключами окружения; без них срабатывания
          записываются в историю без отправки.
          {!canManage ? ' У вас нет прав на изменение правил — доступен только просмотр.' : ''}
        </p>
      </header>

      {error ? (
        <div className="rounded border border-red-900 bg-red-950 p-3 text-sm text-red-200">
          {error}
        </div>
      ) : null}

      {canManage ? (
        <section className="space-y-3 rounded border border-neutral-800 bg-neutral-950 p-4">
          <h2 className="text-xs uppercase tracking-widest text-neutral-400">Добавить правило</h2>
          <form onSubmit={createRule} className="space-y-3">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <label className="block text-xs">
                <span className="mb-1 block text-neutral-400">Имя</span>
                <input
                  type="text"
                  value={form.name}
                  onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
                  placeholder="Падение боевого сервера"
                  className="w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-sm"
                />
              </label>
              <label className="block text-xs">
                <span className="mb-1 block text-neutral-400">Тип</span>
                <select
                  value={form.type}
                  onChange={(event) => setForm((prev) => ({ ...prev, type: event.target.value }))}
                  className="w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-sm"
                >
                  {TYPE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {selectedType ? <p className="text-xs text-neutral-500">{selectedType.hint}</p> : null}

            {form.type === 'unusual_activity' ? (
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <label className="block text-xs">
                  <span className="mb-1 block text-neutral-400">Окно (мин)</span>
                  <input
                    type="number"
                    min={1}
                    value={form.windowMinutes}
                    onChange={(event) =>
                      setForm((prev) => ({
                        ...prev,
                        windowMinutes: Number(event.target.value) || 1,
                      }))
                    }
                    className="w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-sm"
                  />
                </label>
                <label className="block text-xs">
                  <span className="mb-1 block text-neutral-400">Порог подключений</span>
                  <input
                    type="number"
                    min={1}
                    value={form.connectThreshold}
                    onChange={(event) =>
                      setForm((prev) => ({
                        ...prev,
                        connectThreshold: Number(event.target.value) || 1,
                      }))
                    }
                    className="w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-sm"
                  />
                </label>
              </div>
            ) : null}

            {form.type === 'custom' ? (
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <label className="block text-xs">
                  <span className="mb-1 block text-neutral-400">Тип события (eventKind)</span>
                  <input
                    type="text"
                    value={form.eventKind}
                    onChange={(event) =>
                      setForm((prev) => ({ ...prev, eventKind: event.target.value }))
                    }
                    placeholder="rcon.disconnected"
                    className="w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-sm"
                  />
                </label>
                <label className="block text-xs">
                  <span className="mb-1 block text-neutral-400">Порог (0 — без порога)</span>
                  <input
                    type="number"
                    min={0}
                    value={form.threshold}
                    onChange={(event) =>
                      setForm((prev) => ({ ...prev, threshold: Number(event.target.value) || 0 }))
                    }
                    className="w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-sm"
                  />
                </label>
              </div>
            ) : null}

            <div className="block text-xs">
              <span className="mb-1 block text-neutral-400">Каналы доставки</span>
              <div className="flex flex-wrap gap-3">
                {CHANNEL_OPTIONS.map((option) => (
                  <label key={option.value} className="flex cursor-pointer items-center gap-2">
                    <input
                      type="checkbox"
                      checked={form.channels.includes(option.value)}
                      onChange={() => toggleChannel(option.value)}
                      className="h-4 w-4"
                    />
                    <span className="text-neutral-300">{option.label}</span>
                  </label>
                ))}
              </div>
            </div>

            <button
              type="submit"
              disabled={creating}
              className="rounded border border-emerald-900 px-4 py-1.5 text-sm text-emerald-300 hover:border-emerald-700 disabled:opacity-40"
            >
              {creating ? 'Создание…' : 'Добавить правило'}
            </button>
          </form>
        </section>
      ) : null}

      <section className="space-y-3">
        <h2 className="text-xs uppercase tracking-widest text-neutral-400">Правила</h2>
        {rules.length === 0 ? (
          <div className="rounded border border-neutral-800 bg-neutral-950 p-6 text-center text-sm text-neutral-500">
            Правил пока нет.
          </div>
        ) : (
          rules.map((rule) => (
            <div
              key={rule.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-neutral-800 bg-neutral-950 p-4"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-base font-semibold">{rule.name}</h3>
                  <span className="rounded bg-neutral-900 px-2 py-0.5 text-[10px] uppercase text-neutral-400">
                    {typeLabel(rule.type)}
                  </span>
                  {rule.channels.map((channel) => (
                    <span
                      key={channel}
                      className="rounded bg-neutral-900 px-2 py-0.5 text-[10px] uppercase text-neutral-500"
                    >
                      {channel}
                    </span>
                  ))}
                </div>
              </div>
              <div className="flex items-center gap-3">
                <label
                  className={`flex items-center gap-2 text-xs ${
                    canManage ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'
                  }`}
                >
                  <span className="text-neutral-400">
                    {rule.enabled ? 'Включено' : 'Выключено'}
                  </span>
                  <input
                    type="checkbox"
                    aria-label={`Включить правило ${rule.name}`}
                    checked={rule.enabled}
                    disabled={!canManage || busyId === rule.id}
                    onChange={() => toggleEnabled(rule)}
                    className="h-4 w-9 cursor-pointer appearance-none rounded-full bg-neutral-800 transition-all checked:bg-sky-600 disabled:cursor-not-allowed"
                    style={{
                      backgroundImage:
                        'radial-gradient(circle 7px at 8px center, white 100%, transparent 100%)',
                    }}
                  />
                </label>
                {canManage ? (
                  <button
                    type="button"
                    disabled={busyId === rule.id}
                    onClick={() => removeRule(rule)}
                    title="Удалить правило"
                    className="rounded border border-red-900 px-2 py-1 text-xs text-red-300 hover:bg-red-950 disabled:opacity-40"
                  >
                    ⌫
                  </button>
                ) : null}
              </div>
            </div>
          ))
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-xs uppercase tracking-widest text-neutral-400">История срабатываний</h2>
        {events.length === 0 ? (
          <div className="rounded border border-neutral-800 bg-neutral-950 p-6 text-center text-sm text-neutral-500">
            Срабатываний пока нет.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-neutral-800">
            <table className="w-full min-w-[640px] text-left text-xs">
              <thead className="bg-neutral-900 text-neutral-400">
                <tr>
                  <th className="px-3 py-2 font-medium">Время</th>
                  <th className="px-3 py-2 font-medium">Правило</th>
                  <th className="px-3 py-2 font-medium">Важность</th>
                  <th className="px-3 py-2 font-medium">Доставлено</th>
                  <th className="px-3 py-2 font-medium">Данные</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <tr key={event.id} className="border-t border-neutral-900">
                    <td className="whitespace-nowrap px-3 py-2 text-neutral-300">
                      {formatDate(event.triggered_at)}
                    </td>
                    <td className="px-3 py-2 text-neutral-200">
                      {event.rule_name ?? '—'}
                      {event.rule_type ? (
                        <span className="ml-1 text-neutral-500">
                          ({typeLabel(event.rule_type)})
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`rounded border px-2 py-0.5 text-[10px] uppercase ${
                          SEVERITY_BADGE[event.severity] ?? SEVERITY_BADGE.info
                        }`}
                      >
                        {event.severity}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      {event.delivered ? (
                        <span className="text-emerald-400">да</span>
                      ) : (
                        <span className="text-neutral-500">нет</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <code className="break-all font-mono text-[11px] text-neutral-500">
                        {JSON.stringify(event.payload)}
                      </code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
