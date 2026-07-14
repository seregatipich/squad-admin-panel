'use client';

import { useCallback, useEffect, useState } from 'react';
import { PublicationSection } from './PublicationSection';

interface BanSource {
  id: string;
  name: string;
  url: string;
  format: string;
  trust_level: string;
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

const TRUST_BADGE: Record<string, string> = {
  trusted: 'border-emerald-800 bg-emerald-950/50 text-emerald-300',
  normal: 'border-sky-800 bg-sky-950/50 text-sky-300',
  low: 'border-amber-800 bg-amber-950/50 text-amber-300',
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
  discord_url: '',
  auth_header: '',
  poll_interval_minutes: 60,
};

export default function BanSourcesPage() {
  const [sources, setSources] = useState<BanSource[] | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [sourcesRes, meRes] = await Promise.all([
      fetch('/api/v1/ban-sources', { credentials: 'include', cache: 'no-store' }),
      fetch('/api/v1/me', { credentials: 'include', cache: 'no-store' }),
    ]);
    if (sourcesRes.ok) setSources((await sourcesRes.json()) as BanSource[]);
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
    if (!confirm(`Удалить источник «${source.name}» и все его импортированные баны?`)) return;
    setBusyId(source.id);
    setError(null);
    try {
      const res = await fetch(`/api/v1/ban-sources/${source.id}`, {
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

  if (!sources || !me) return <div className="text-neutral-500">Загрузка…</div>;

  return (
    <div className="max-w-4xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Источники банов</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Подписки на внешние банлисты сообществ. Синхронизация импортирует записи в общую сеть
          банов.
          {!canManage ? ' У вас нет прав на изменение источников — доступен только просмотр.' : ''}
        </p>
      </header>

      {error ? (
        <div className="rounded border border-red-900 bg-red-950 p-3 text-sm text-red-200">
          {error}
        </div>
      ) : null}

      {canManage ? (
        <section className="space-y-3 rounded border border-neutral-800 bg-neutral-950 p-4">
          <h2 className="text-xs uppercase tracking-widest text-neutral-400">Добавить источник</h2>
          <form onSubmit={createSource} className="space-y-3">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <label className="block text-xs">
                <span className="mb-1 block text-neutral-400">Имя</span>
                <input
                  type="text"
                  value={form.name}
                  onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
                  placeholder="Ру-Баны (collabans)"
                  className="w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-sm"
                />
              </label>
              <label className="block text-xs">
                <span className="mb-1 block text-neutral-400">URL банлиста</span>
                <input
                  type="url"
                  value={form.url}
                  onChange={(event) => setForm((prev) => ({ ...prev, url: event.target.value }))}
                  placeholder="https://example.com/bans.cfg"
                  className="w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-sm"
                />
              </label>
              <label className="block text-xs">
                <span className="mb-1 block text-neutral-400">Формат</span>
                <select
                  value={form.format}
                  onChange={(event) => setForm((prev) => ({ ...prev, format: event.target.value }))}
                  className="w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-sm"
                >
                  {FORMAT_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-xs">
                <span className="mb-1 block text-neutral-400">Уровень доверия</span>
                <select
                  value={form.trust_level}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, trust_level: event.target.value }))
                  }
                  className="w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-sm"
                >
                  {TRUST_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-xs">
                <span className="mb-1 block text-neutral-400">Discord (необязательно)</span>
                <input
                  type="url"
                  value={form.discord_url}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, discord_url: event.target.value }))
                  }
                  placeholder="https://discord.gg/…"
                  className="w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-sm"
                />
              </label>
              <label className="block text-xs">
                <span className="mb-1 block text-neutral-400">Интервал опроса (мин, ≥15)</span>
                <input
                  type="number"
                  min={15}
                  value={form.poll_interval_minutes}
                  onChange={(event) =>
                    setForm((prev) => ({
                      ...prev,
                      poll_interval_minutes: Number(event.target.value) || 60,
                    }))
                  }
                  className="w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-sm"
                />
              </label>
            </div>
            <label className="block text-xs">
              <span className="mb-1 block text-neutral-400">
                Auth-заголовок (секрет, хранится зашифрованным, не отображается)
              </span>
              <input
                type="password"
                value={form.auth_header}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, auth_header: event.target.value }))
                }
                placeholder="Bearer …"
                autoComplete="new-password"
                className="w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-sm"
              />
            </label>
            <button
              type="submit"
              disabled={creating}
              className="rounded border border-emerald-900 px-4 py-1.5 text-sm text-emerald-300 hover:border-emerald-700 disabled:opacity-40"
            >
              {creating ? 'Создание…' : 'Добавить источник'}
            </button>
          </form>
        </section>
      ) : null}

      <div className="space-y-3">
        {sources.length === 0 ? (
          <div className="rounded border border-neutral-800 bg-neutral-950 p-6 text-center text-sm text-neutral-500">
            Источников пока нет.
          </div>
        ) : (
          sources.map((source) => (
            <section
              key={source.id}
              className="rounded-lg border border-neutral-800 bg-neutral-950 p-5"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-lg font-semibold">{source.name}</h2>
                    <span
                      className={`rounded border px-2 py-0.5 text-[10px] uppercase ${
                        TRUST_BADGE[source.trust_level] ?? TRUST_BADGE.normal
                      }`}
                    >
                      {trustLabel(source.trust_level)}
                    </span>
                    <span className="rounded bg-neutral-900 px-2 py-0.5 text-[10px] uppercase text-neutral-400">
                      {formatLabel(source.format)}
                    </span>
                    {source.has_auth_header ? (
                      <span
                        title="Настроен приватный auth-заголовок"
                        className="rounded bg-neutral-900 px-2 py-0.5 text-[10px] uppercase text-neutral-400"
                      >
                        🔒 auth
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-1 break-all font-mono text-xs text-neutral-500">
                    {source.url}
                  </div>
                  {source.discord_url ? (
                    <a
                      href={source.discord_url}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-1 inline-block text-xs text-sky-400 hover:text-sky-300"
                    >
                      Discord сообщества →
                    </a>
                  ) : null}
                </div>
                {canManage ? (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={busyId === source.id}
                      onClick={() => syncNow(source)}
                      className="rounded border border-sky-800 px-3 py-1 text-xs text-sky-300 hover:bg-sky-950 disabled:opacity-40"
                    >
                      {busyId === source.id ? '…' : 'Синхронизировать'}
                    </button>
                    <button
                      type="button"
                      disabled={busyId === source.id}
                      onClick={() => removeSource(source)}
                      title="Удалить источник"
                      className="rounded border border-red-900 px-2 py-1 text-xs text-red-300 hover:bg-red-950 disabled:opacity-40"
                    >
                      ⌫
                    </button>
                  </div>
                ) : null}
              </div>

              <div className="mt-4 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
                <div>
                  <div className="text-neutral-500">Записей</div>
                  <div className="mt-0.5 text-sm text-neutral-200">{source.record_count}</div>
                </div>
                <div>
                  <div className="text-neutral-500">Интервал</div>
                  <div className="mt-0.5 text-sm text-neutral-200">
                    {source.poll_interval_minutes} мин
                  </div>
                </div>
                <div>
                  <div className="text-neutral-500">Последний синк</div>
                  <div className="mt-0.5 text-sm text-neutral-200">
                    {formatDate(source.last_sync_at)}
                  </div>
                </div>
                <div>
                  <div className="text-neutral-500">Статус</div>
                  <div className="mt-0.5">
                    {source.last_sync_status === 'error' ? (
                      <span className="rounded bg-red-950/60 px-2 py-0.5 text-xs text-red-300">
                        ошибка
                      </span>
                    ) : source.last_sync_status === 'ok' ? (
                      <span className="rounded bg-emerald-950/60 px-2 py-0.5 text-xs text-emerald-300">
                        ok
                      </span>
                    ) : (
                      <span className="text-xs text-neutral-500">—</span>
                    )}
                  </div>
                </div>
              </div>

              {source.last_sync_status === 'error' && source.last_sync_error ? (
                <div className="mt-3 rounded border border-red-900 bg-red-950/40 p-2 font-mono text-xs text-red-300">
                  {source.last_sync_error}
                </div>
              ) : null}

              <div className="mt-4 flex items-center justify-between border-t border-neutral-900 pt-3">
                <span className="text-xs text-neutral-500">
                  {source.enabled ? 'Активен — опрашивается по расписанию' : 'Выключен'}
                </span>
                <label
                  className={`flex items-center gap-2 text-xs ${
                    canManage ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'
                  }`}
                >
                  <span className="text-neutral-400">Включён</span>
                  <input
                    type="checkbox"
                    aria-label={`Включить источник ${source.name}`}
                    checked={source.enabled}
                    disabled={!canManage || busyId === source.id}
                    onChange={() => toggleEnabled(source)}
                    className="h-4 w-9 cursor-pointer appearance-none rounded-full bg-neutral-800 transition-all checked:bg-sky-600 disabled:cursor-not-allowed"
                    style={{
                      backgroundImage:
                        'radial-gradient(circle 7px at 8px center, white 100%, transparent 100%)',
                    }}
                  />
                </label>
              </div>
            </section>
          ))
        )}
      </div>

      <PublicationSection />
    </div>
  );
}
