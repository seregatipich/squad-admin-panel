'use client';

import { useCallback, useEffect, useState } from 'react';
import { type ClanGuardSettings, formatUpdatedAt, validateGracePeriod } from './helpers';

interface Me {
  can_manage_clans: boolean;
}

export default function ClanGuardSettingsPage() {
  const [settings, setSettings] = useState<ClanGuardSettings | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [gracePeriodInput, setGracePeriodInput] = useState('300');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [globalErr, setGlobalErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    const [settingsRes, meRes] = await Promise.all([
      fetch('/api/v1/settings/clan-guard', { credentials: 'include', cache: 'no-store' }),
      fetch('/api/v1/me', { credentials: 'include', cache: 'no-store' }),
    ]);
    if (settingsRes.ok) {
      const loaded = (await settingsRes.json()) as ClanGuardSettings;
      setSettings(loaded);
      setEnabled(loaded.enabled);
      setGracePeriodInput(String(loaded.grace_period_seconds));
    } else {
      setGlobalErr(`Не удалось загрузить настройки: ${settingsRes.status}`);
    }
    if (meRes.ok) setMe((await meRes.json()) as Me);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const canManage = me?.can_manage_clans ?? false;

  async function save() {
    if (!settings || !canManage) return;
    const validation = validateGracePeriod(gracePeriodInput);
    if (!validation.ok) {
      setFieldError(validation.error);
      setGlobalErr('Исправьте выделенное поле.');
      return;
    }
    setFieldError(null);
    setGlobalErr(null);
    setSaving(true);
    try {
      const res = await fetch('/api/v1/settings/clan-guard', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled, grace_period_seconds: validation.value }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        setGlobalErr(`Ошибка сохранения: ${err.error ?? res.status}`);
        return;
      }
      const fresh = (await res.json()) as ClanGuardSettings;
      setSettings(fresh);
      setEnabled(fresh.enabled);
      setGracePeriodInput(String(fresh.grace_period_seconds));
      setNotice('Настройки защиты клан-тегов сохранены.');
    } catch (err) {
      setGlobalErr(`Ошибка сети: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  if (!settings || !me) {
    return <div className="text-neutral-500">Загрузка…</div>;
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Защита клан-тегов</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Механизм предупреждает и кикает игроков, которые носят тег клана с включённой защитой
          тега, но не состоят в его ростере. Настройки конкретного клана — на его странице.
        </p>
      </header>

      {globalErr ? (
        <div className="rounded border border-red-900 bg-red-950 p-3 text-sm text-red-200">
          {globalErr}
        </div>
      ) : null}
      {notice ? (
        <div className="rounded border border-emerald-900 bg-emerald-950 p-3 text-sm text-emerald-200">
          {notice}
        </div>
      ) : null}
      {!canManage ? (
        <div className="rounded border border-neutral-800 bg-neutral-900/60 p-3 text-sm text-neutral-400">
          Просмотр доступен, но для изменения настроек нужно право «Управление кланами».
        </div>
      ) : null}

      <section className="rounded-lg border border-neutral-800 bg-neutral-950 p-5">
        <label className="flex items-center justify-between gap-4">
          <span>
            <span className="block text-sm font-medium text-neutral-200">
              Механизм защиты клан-тегов
            </span>
            <span className="mt-0.5 block text-xs text-neutral-500">
              Глобальный выключатель. Выключение мгновенно останавливает все предупреждения и кики.
            </span>
          </span>
          <input
            type="checkbox"
            aria-label="Механизм защиты клан-тегов"
            checked={enabled}
            disabled={!canManage}
            onChange={(e) => {
              setEnabled(e.target.checked);
              setNotice(null);
            }}
            className="h-5 w-11 shrink-0 cursor-pointer appearance-none rounded-full bg-neutral-800 transition-all checked:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-60"
            style={{
              backgroundImage:
                'radial-gradient(circle 8px at 9px center, white 100%, transparent 100%)',
            }}
          />
        </label>
        <div className="mt-3 text-xs">
          <span
            className={`rounded px-2 py-0.5 ${
              enabled ? 'bg-emerald-950 text-emerald-300' : 'bg-neutral-800 text-neutral-400'
            }`}
          >
            {enabled ? 'Механизм активен' : 'Механизм выключен'}
          </span>
        </div>

        <label className="mt-5 block text-xs">
          <span className="mb-1 block text-neutral-400">Грейс-период (сек.)</span>
          <input
            type="number"
            inputMode="numeric"
            step="1"
            min={0}
            max={3600}
            value={gracePeriodInput}
            disabled={!canManage}
            onChange={(e) => {
              setGracePeriodInput(e.target.value);
              setFieldError(null);
              setNotice(null);
            }}
            className={`w-full max-w-xs rounded border bg-neutral-900 px-2 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-60 ${
              fieldError ? 'border-red-800' : 'border-neutral-800'
            }`}
          />
          <span className="mt-1 block text-[11px] text-neutral-500">
            Время между предупреждением и киком, если игрок не сменил ник.
          </span>
          {fieldError ? (
            <span className="mt-1 block text-[11px] text-red-400">{fieldError}</span>
          ) : null}
        </label>
      </section>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-xs text-neutral-500">
          Последнее изменение: {formatUpdatedAt(settings.updated_at)}
        </span>
        {canManage ? (
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            className="rounded-md border border-sky-700 bg-sky-950 px-4 py-2 text-sm text-sky-200 hover:bg-sky-900 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saving ? 'Сохраняем…' : 'Сохранить'}
          </button>
        ) : null}
      </div>
    </div>
  );
}
