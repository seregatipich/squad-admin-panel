'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  COEFFICIENT_FIELDS,
  type EconomyFormState,
  type EconomySettings,
  formatUpdatedAt,
  SEED_THRESHOLD_MAX,
  SEED_THRESHOLD_MIN,
  settingsToForm,
  validateEconomyForm,
} from './helpers';

interface Me {
  can_manage_economy: boolean;
}

type FieldErrors = Partial<Record<keyof EconomyFormState, string>>;

export default function EconomySettingsPage() {
  const [settings, setSettings] = useState<EconomySettings | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [form, setForm] = useState<EconomyFormState | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [globalErr, setGlobalErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    const [settingsRes, meRes] = await Promise.all([
      fetch('/api/v1/settings/economy', { credentials: 'include', cache: 'no-store' }),
      fetch('/api/v1/me', { credentials: 'include', cache: 'no-store' }),
    ]);
    if (settingsRes.ok) {
      const loaded = (await settingsRes.json()) as EconomySettings;
      setSettings(loaded);
      setForm(settingsToForm(loaded));
    } else {
      setGlobalErr(`Не удалось загрузить настройки: ${settingsRes.status}`);
    }
    if (meRes.ok) setMe((await meRes.json()) as Me);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const canManage = me?.can_manage_economy ?? false;

  function updateField(key: keyof EconomyFormState, value: string | boolean) {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
    setNotice(null);
    setErrors((prev) => ({ ...prev, [key]: undefined }));
  }

  async function save() {
    if (!form || !canManage) return;
    const validation = validateEconomyForm(form);
    if (!validation.ok) {
      setErrors(validation.errors);
      setGlobalErr('Исправьте выделенные поля.');
      return;
    }
    setErrors({});
    setGlobalErr(null);
    setSaving(true);
    try {
      const res = await fetch('/api/v1/settings/economy', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(validation.value),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        setGlobalErr(`Ошибка сохранения: ${err.error ?? res.status}`);
        return;
      }
      const fresh = (await res.json()) as EconomySettings;
      setSettings(fresh);
      setForm(settingsToForm(fresh));
      setNotice('Настройки экономики сохранены.');
    } catch (err) {
      setGlobalErr(`Ошибка сети: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  if (!settings || !form || !me) {
    return <div className="text-neutral-500">Загрузка…</div>;
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Экономика организации</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Коэффициенты начисления бонусов и порог сида. Изменения влияют только на будущие
          начисления — уже начисленные бонусы не пересчитываются.
        </p>
      </header>

      <div className="rounded-lg border border-amber-900 bg-amber-950/40 p-4 text-sm text-amber-200">
        <div className="font-semibold">Монетизационная механика</div>
        <p className="mt-1 text-amber-200/80">
          Экономика бонусов — это механика монетизации. По умолчанию она{' '}
          <span className="font-semibold">выключена</span>. Пока переключатель ниже выключен, воркер
          начислений не работает и связанные блоки интерфейса скрыты.
        </p>
      </div>

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
          Просмотр доступен, но для изменения настроек нужно право «Управление экономикой».
        </div>
      ) : null}

      <section className="rounded-lg border border-neutral-800 bg-neutral-950 p-5">
        <label className="flex items-center justify-between gap-4">
          <span>
            <span className="block text-sm font-medium text-neutral-200">Экономика включена</span>
            <span className="mt-0.5 block text-xs text-neutral-500">
              Разрешить воркеру начислять бонусы игрокам за онлайн, буст и сид.
            </span>
          </span>
          <input
            type="checkbox"
            aria-label="Экономика включена"
            checked={form.economyEnabled}
            disabled={!canManage}
            onChange={(e) => updateField('economyEnabled', e.target.checked)}
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
              form.economyEnabled
                ? 'bg-emerald-950 text-emerald-300'
                : 'bg-neutral-800 text-neutral-400'
            }`}
          >
            {form.economyEnabled ? 'Начисления активны' : 'Начисления выключены'}
          </span>
        </div>
      </section>

      <section className="rounded-lg border border-neutral-800 bg-neutral-950 p-5">
        <h2 className="text-sm font-semibold uppercase tracking-widest text-neutral-500">
          Коэффициенты начисления
        </h2>
        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-3">
          {COEFFICIENT_FIELDS.map((field) => (
            <label key={field.key} className="block text-xs">
              <span className="mb-1 block text-neutral-400">{field.label}</span>
              <input
                type="number"
                inputMode="decimal"
                step="0.1"
                min={0}
                value={form[field.key]}
                disabled={!canManage}
                onChange={(e) => updateField(field.key, e.target.value)}
                className={`w-full rounded border bg-neutral-900 px-2 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-60 ${
                  errors[field.key] ? 'border-red-800' : 'border-neutral-800'
                }`}
              />
              <span className="mt-1 block text-[11px] text-neutral-500">{field.hint}</span>
              {errors[field.key] ? (
                <span className="mt-1 block text-[11px] text-red-400">{errors[field.key]}</span>
              ) : null}
            </label>
          ))}
        </div>

        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
          <label className="block text-xs">
            <span className="mb-1 block text-neutral-400">
              Порог сида (игроков), seed_threshold
            </span>
            <input
              type="number"
              inputMode="numeric"
              step="1"
              min={SEED_THRESHOLD_MIN}
              max={SEED_THRESHOLD_MAX}
              value={form.seedThreshold}
              disabled={!canManage}
              onChange={(e) => updateField('seedThreshold', e.target.value)}
              className={`w-full rounded border bg-neutral-900 px-2 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-60 ${
                errors.seedThreshold ? 'border-red-800' : 'border-neutral-800'
              }`}
            />
            <span className="mt-1 block text-[11px] text-neutral-500">
              Если на сервере меньше этого числа игроков, время засчитывается как сид.
            </span>
            {errors.seedThreshold ? (
              <span className="mt-1 block text-[11px] text-red-400">{errors.seedThreshold}</span>
            ) : null}
          </label>
        </div>
      </section>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-xs text-neutral-500">
          Последнее изменение: {formatUpdatedAt(settings.updated_at)}
        </span>
        {canManage ? (
          <button
            type="button"
            onClick={save}
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
