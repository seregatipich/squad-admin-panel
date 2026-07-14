'use client';

import { useCallback, useEffect, useState } from 'react';

type PublishScope = 'all_active' | 'permanent_only';

interface PublicationSettings {
  enabled: boolean;
  publish_scope: PublishScope;
  updated_at: string | null;
}

function formatUpdatedAt(iso: string | null): string {
  if (!iso) return 'ещё не изменялось';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'ещё не изменялось';
  return date.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * «Публикация банлиста» (CBAN-5) — секция на `/settings/ban-sources`
 * управляющая outbound-федерацией: master-свитч и выбор, что публиковать
 * (все активные баны / только перманентные). Источник данных для другого
 * инстанса панели — `GET /api/v1/public/banlist`, требующий API-токен со
 * scope `banlist:read`. Скрывается целиком для пользователей без
 * `can_manage_ban_sources` (эндпоинт настроек отвечает 401/403).
 */
export function PublicationSection() {
  const [settings, setSettings] = useState<PublicationSettings | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [scope, setScope] = useState<PublishScope>('all_active');
  const [hidden, setHidden] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/v1/settings/banlist-publication', {
        credentials: 'include',
        cache: 'no-store',
      });
      if (res.status === 401 || res.status === 403) {
        setHidden(true);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as PublicationSettings;
      setSettings(body);
      setEnabled(body.enabled);
      setScope(body.publish_scope);
    } catch (err) {
      setError(`Не удалось загрузить настройки публикации: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function save() {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch('/api/v1/settings/banlist-publication', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled, publish_scope: scope }),
      });
      if (res.status === 401 || res.status === 403) {
        setHidden(true);
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        throw new Error(String(body.error ?? res.status));
      }
      const fresh = (await res.json()) as PublicationSettings;
      setSettings(fresh);
      setEnabled(fresh.enabled);
      setScope(fresh.publish_scope);
      setNotice('Настройки публикации банлиста сохранены.');
    } catch (err) {
      setError(`Не удалось сохранить настройки: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  if (hidden) return null;
  if (loading) return <div className="text-sm text-neutral-500">Загрузка настроек публикации…</div>;
  if (!settings) return null;

  return (
    <section className="space-y-4 rounded-lg border border-neutral-800 bg-neutral-950 p-5">
      <header>
        <h2 className="text-lg font-semibold">Публикация банлиста</h2>
        <p className="mt-1 text-sm text-neutral-500">
          Отдаёт собственный список банов другому инстансу панели (CBAN-5) — федерация без
          центрального сервера.
        </p>
      </header>

      {error ? (
        <div className="rounded border border-red-900 bg-red-950 p-3 text-sm text-red-200">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="rounded border border-emerald-900 bg-emerald-950 p-3 text-sm text-emerald-200">
          {notice}
        </div>
      ) : null}

      <label className="flex items-center justify-between gap-4">
        <span>
          <span className="block text-sm font-medium text-neutral-200">
            Публиковать банлист наружу
          </span>
          <span className="mt-0.5 block text-xs text-neutral-500">
            Master-свитч. Выключение мгновенно останавливает выдачу — токены со scope «banlist:read»
            начнут получать 404.
          </span>
        </span>
        <input
          type="checkbox"
          aria-label="Публиковать банлист наружу"
          checked={enabled}
          onChange={(e) => {
            setEnabled(e.target.checked);
            setNotice(null);
          }}
          className="h-5 w-11 shrink-0 cursor-pointer appearance-none rounded-full bg-neutral-800 transition-all checked:bg-sky-600"
          style={{
            backgroundImage:
              'radial-gradient(circle 8px at 9px center, white 100%, transparent 100%)',
          }}
        />
      </label>

      <fieldset className="space-y-2">
        <legend className="mb-1 text-xs text-neutral-400">Что публиковать</legend>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="banlist-publish-scope"
            value="all_active"
            checked={scope === 'all_active'}
            onChange={() => {
              setScope('all_active');
              setNotice(null);
            }}
          />
          Все активные баны
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="banlist-publish-scope"
            value="permanent_only"
            checked={scope === 'permanent_only'}
            onChange={() => {
              setScope('permanent_only');
              setNotice(null);
            }}
          />
          Только перманентные
        </label>
      </fieldset>

      <div className="rounded border border-neutral-800 bg-neutral-900/60 p-3 text-xs text-neutral-400">
        <div className="font-mono text-neutral-300">
          GET /api/v1/public/banlist?format=squad_cfg|json
        </div>
        <p className="mt-1">
          Требуется API-токен со scope <span className="font-mono">banlist:read</span> (Настройки →
          Токены).
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-neutral-900 pt-3">
        <span className="text-xs text-neutral-500">
          Последнее изменение: {formatUpdatedAt(settings.updated_at)}
        </span>
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="rounded-md border border-sky-700 bg-sky-950 px-4 py-2 text-sm text-sky-200 hover:bg-sky-900 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {saving ? 'Сохраняем…' : 'Сохранить'}
        </button>
      </div>
    </section>
  );
}
