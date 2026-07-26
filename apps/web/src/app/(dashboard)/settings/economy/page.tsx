'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  COEFFICIENT_FIELDS,
  type EconomyFormState,
  type EconomySettings,
  emptyTierForm,
  formatTierDuration,
  formatUpdatedAt,
  SEED_THRESHOLD_MAX,
  SEED_THRESHOLD_MIN,
  settingsToForm,
  tierToForm,
  VIP_TIER_DEFAULT_DAYS_MAX,
  VIP_TIER_DEFAULT_DAYS_MIN,
  VIP_TIER_NAME_MAX,
  VIP_TIER_SORT_ORDER_MAX,
  VIP_TIER_SORT_ORDER_MIN,
  type VipTier,
  type VipTierFormState,
  validateEconomyForm,
  validateVipTierForm,
} from './helpers';

interface Me {
  can_manage_economy: boolean;
  permissions: string[];
}

interface RoleOption {
  id: string;
  name: string;
}

type FieldErrors = Partial<Record<keyof EconomyFormState, string>>;

type TierFieldErrors = Partial<Record<keyof VipTierFormState, string>>;

const TIER_ERROR_MESSAGES: Record<string, string> = {
  vip_tier_name_taken: 'Тир с таким названием уже существует.',
  vip_tier_has_active_assignments: 'Нельзя удалить тир: у него есть активные назначения.',
  role_referenced_by_vip_tier: 'Роль привязана к VIP-тиру — сначала удалите тир.',
  role_in_use: 'Роль используется и не может быть удалена.',
};

function tierErrorText(code: unknown, status: number): string {
  return (typeof code === 'string' && TIER_ERROR_MESSAGES[code]) || String(code ?? status);
}

export default function EconomySettingsPage() {
  const [settings, setSettings] = useState<EconomySettings | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [form, setForm] = useState<EconomyFormState | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [globalErr, setGlobalErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [tiers, setTiers] = useState<VipTier[]>([]);
  const [roleOptions, setRoleOptions] = useState<RoleOption[]>([]);
  const [tierForm, setTierForm] = useState<VipTierFormState | null>(null);
  const [editingTierId, setEditingTierId] = useState<string | null>(null);
  const [tierErrors, setTierErrors] = useState<TierFieldErrors>({});
  const [tierErr, setTierErr] = useState<string | null>(null);
  const [tierSaving, setTierSaving] = useState(false);

  const refresh = useCallback(async () => {
    const [settingsRes, meRes, tiersRes, rolesRes] = await Promise.all([
      fetch('/api/v1/settings/economy', { credentials: 'include', cache: 'no-store' }),
      fetch('/api/v1/me', { credentials: 'include', cache: 'no-store' }),
      fetch('/api/v1/vip-tiers', { credentials: 'include', cache: 'no-store' }),
      fetch('/api/v1/roles', { credentials: 'include', cache: 'no-store' }),
    ]);
    if (settingsRes.ok) {
      const loaded = (await settingsRes.json()) as EconomySettings;
      setSettings(loaded);
      setForm(settingsToForm(loaded));
    } else {
      setGlobalErr(`Не удалось загрузить настройки: ${settingsRes.status}`);
    }
    if (meRes.ok) setMe((await meRes.json()) as Me);
    // Both endpoints 403 without can_edit_roles — the section is hidden then,
    // so a failed load is not an error worth surfacing.
    if (tiersRes.ok) setTiers(((await tiersRes.json()) as { rows: VipTier[] }).rows);
    if (rolesRes.ok) setRoleOptions((await rolesRes.json()) as RoleOption[]);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const canManage = me?.can_manage_economy ?? false;
  const canEditTiers = me?.permissions?.includes('role:edit') ?? false;

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

  function updateTierField(key: keyof VipTierFormState, value: string | boolean) {
    setTierForm((prev) => (prev ? { ...prev, [key]: value } : prev));
    setTierErrors((prev) => ({ ...prev, [key]: undefined }));
  }

  function startTierCreate() {
    setTierForm(emptyTierForm());
    setEditingTierId(null);
    setTierErrors({});
    setTierErr(null);
  }

  function startTierEdit(tier: VipTier) {
    setTierForm(tierToForm(tier));
    setEditingTierId(tier.id);
    setTierErrors({});
    setTierErr(null);
  }

  function cancelTierForm() {
    setTierForm(null);
    setEditingTierId(null);
    setTierErrors({});
  }

  async function saveTier() {
    if (!tierForm || !canEditTiers) return;
    const validation = validateVipTierForm(tierForm);
    if (!validation.ok) {
      setTierErrors(validation.errors);
      setTierErr('Исправьте выделенные поля.');
      return;
    }
    setTierErrors({});
    setTierErr(null);
    setTierSaving(true);
    try {
      const res = await fetch(
        editingTierId ? `/api/v1/vip-tiers/${editingTierId}` : '/api/v1/vip-tiers',
        {
          method: editingTierId ? 'PUT' : 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(validation.value),
        },
      );
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        setTierErr(`Ошибка сохранения тира: ${tierErrorText(err.error, res.status)}`);
        return;
      }
      cancelTierForm();
      await refresh();
    } catch (err) {
      setTierErr(`Ошибка сети: ${(err as Error).message}`);
    } finally {
      setTierSaving(false);
    }
  }

  async function removeTier(tier: VipTier) {
    if (!canEditTiers) return;
    if (!confirm(`Удалить тир «${tier.name}»? Уже выданные роли останутся у игроков.`)) return;
    setTierErr(null);
    const res = await fetch(`/api/v1/vip-tiers/${tier.id}`, {
      method: 'DELETE',
      credentials: 'include',
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      setTierErr(`Ошибка удаления тира: ${tierErrorText(err.error, res.status)}`);
      return;
    }
    await refresh();
  }

  if (!settings || !form || !me) {
    return <div className="text-neutral-500">Загрузка…</div>;
  }

  const roleNameById = new Map(roleOptions.map((r) => [r.id, r.name]));

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

      <section
        aria-label="Напоминания об истечении VIP"
        className="rounded-lg border border-neutral-800 bg-neutral-950 p-5"
      >
        <h2 className="text-sm font-semibold uppercase tracking-widest text-neutral-500">
          Напоминания об истечении VIP
        </h2>
        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
          <label className="block text-xs">
            <span className="mb-1 block text-neutral-400">
              Окна напоминаний (дней, через запятую)
            </span>
            <input
              type="text"
              aria-label="Окна напоминаний (дней, через запятую)"
              value={form.vipExpiryWindows}
              disabled={!canManage}
              onChange={(e) => updateField('vipExpiryWindows', e.target.value)}
              className={`w-full rounded border bg-neutral-900 px-2 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-60 ${
                errors.vipExpiryWindows ? 'border-red-800' : 'border-neutral-800'
              }`}
            />
            <span className="mt-1 block text-[11px] text-neutral-500">
              За сколько дней до истечения VIP напоминать. Каждое окно срабатывает один раз;
              продление роли выдаёт напоминания заново.
            </span>
            {errors.vipExpiryWindows ? (
              <span className="mt-1 block text-[11px] text-red-400">{errors.vipExpiryWindows}</span>
            ) : null}
          </label>
          <label className="flex items-start gap-2 text-xs text-neutral-300">
            <input
              type="checkbox"
              aria-label="Предупреждать игрока в игре"
              checked={form.vipExpiryWarnInGame}
              disabled={!canManage}
              onChange={(e) => updateField('vipExpiryWarnInGame', e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-neutral-700 bg-neutral-900 text-sky-500 disabled:cursor-not-allowed disabled:opacity-60"
            />
            <span>
              Предупреждать игрока в игре
              <span className="mt-0.5 block text-[11px] text-neutral-500">
                Разовый AdminWarn «VIP истекает через N дн.» при следующем заходе на сервер.
              </span>
            </span>
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

      {canEditTiers ? (
        <section
          aria-label="VIP-тиры"
          className="rounded-lg border border-neutral-800 bg-neutral-950 p-5"
        >
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-widest text-neutral-500">
                VIP-тиры
              </h2>
              <p className="mt-1 text-xs text-neutral-500">
                Каталог VIP-привилегий. Тир связывает роль с описанием и сроком по умолчанию;
                деактивация скрывает тир из магазина, не снимая уже выданные роли.
              </p>
            </div>
            {tierForm === null ? (
              <button
                type="button"
                onClick={startTierCreate}
                className="shrink-0 rounded-md border border-sky-700 bg-sky-950 px-3 py-1.5 text-sm text-sky-200 hover:bg-sky-900"
              >
                + Добавить тир
              </button>
            ) : null}
          </div>

          {tierErr ? (
            <div className="mt-3 rounded border border-red-900 bg-red-950 p-3 text-sm text-red-200">
              {tierErr}
            </div>
          ) : null}

          {tiers.length === 0 && tierForm === null ? (
            <p className="mt-4 text-sm text-neutral-500">Тиров пока нет.</p>
          ) : null}

          {tiers.length > 0 ? (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-neutral-800 text-xs uppercase tracking-wider text-neutral-500">
                    <th className="py-2 pr-3 font-medium">Название</th>
                    <th className="py-2 pr-3 font-medium">Роль</th>
                    <th className="py-2 pr-3 font-medium">Срок</th>
                    <th className="py-2 pr-3 font-medium">Порядок</th>
                    <th className="py-2 pr-3 font-medium">Статус</th>
                    <th className="py-2 font-medium">
                      <span className="sr-only">Действия</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {tiers.map((tier) => (
                    <tr key={tier.id} className="border-b border-neutral-900">
                      <td className="py-2 pr-3">
                        <span className="font-medium text-neutral-200">{tier.name}</span>
                        {tier.description ? (
                          <span className="mt-0.5 block text-xs text-neutral-500">
                            {tier.description}
                          </span>
                        ) : null}
                      </td>
                      <td className="py-2 pr-3 text-neutral-300">
                        {roleNameById.get(tier.role_id) ?? tier.role_id}
                      </td>
                      <td className="py-2 pr-3 text-neutral-300">
                        {formatTierDuration(tier.default_days)}
                      </td>
                      <td className="py-2 pr-3 text-neutral-400">{tier.sort_order}</td>
                      <td className="py-2 pr-3">
                        <span
                          className={`rounded px-2 py-0.5 text-xs ${
                            tier.is_active
                              ? 'bg-emerald-950 text-emerald-300'
                              : 'bg-neutral-800 text-neutral-400'
                          }`}
                        >
                          {tier.is_active ? 'Активен' : 'Скрыт'}
                        </span>
                      </td>
                      <td className="py-2 text-right">
                        <div className="flex justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => startTierEdit(tier)}
                            className="rounded border border-neutral-800 px-2 py-0.5 text-xs text-neutral-300 hover:bg-neutral-900"
                          >
                            Редактировать
                          </button>
                          <button
                            type="button"
                            aria-label={`Удалить тир «${tier.name}»`}
                            onClick={() => removeTier(tier)}
                            className="rounded border border-red-900 px-2 py-0.5 text-xs text-red-300 hover:bg-red-950"
                          >
                            Удалить
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {tierForm ? (
            <div className="mt-4 rounded border border-neutral-800 bg-neutral-900/40 p-4">
              <h3 className="text-sm font-medium text-neutral-200">
                {editingTierId ? 'Редактирование тира' : 'Новый тир'}
              </h3>
              <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-2">
                <label className="block text-xs">
                  <span className="mb-1 block text-neutral-400">Название</span>
                  <input
                    type="text"
                    aria-label="Название тира"
                    maxLength={VIP_TIER_NAME_MAX}
                    value={tierForm.name}
                    onChange={(e) => updateTierField('name', e.target.value)}
                    className={`w-full rounded border bg-neutral-900 px-2 py-1.5 text-sm ${
                      tierErrors.name ? 'border-red-800' : 'border-neutral-800'
                    }`}
                  />
                  {tierErrors.name ? (
                    <span className="mt-1 block text-[11px] text-red-400">{tierErrors.name}</span>
                  ) : null}
                </label>
                <label className="block text-xs">
                  <span className="mb-1 block text-neutral-400">Роль</span>
                  <select
                    aria-label="Роль тира"
                    value={tierForm.roleId}
                    onChange={(e) => updateTierField('roleId', e.target.value)}
                    className={`w-full rounded border bg-neutral-900 px-2 py-1.5 text-sm ${
                      tierErrors.roleId ? 'border-red-800' : 'border-neutral-800'
                    }`}
                  >
                    <option value="">— выберите роль —</option>
                    {roleOptions.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                  {tierErrors.roleId ? (
                    <span className="mt-1 block text-[11px] text-red-400">{tierErrors.roleId}</span>
                  ) : null}
                </label>
                <label className="block text-xs md:col-span-2">
                  <span className="mb-1 block text-neutral-400">Описание</span>
                  <textarea
                    aria-label="Описание тира"
                    rows={2}
                    value={tierForm.description}
                    onChange={(e) => updateTierField('description', e.target.value)}
                    className={`w-full rounded border bg-neutral-900 px-2 py-1.5 text-sm ${
                      tierErrors.description ? 'border-red-800' : 'border-neutral-800'
                    }`}
                  />
                  {tierErrors.description ? (
                    <span className="mt-1 block text-[11px] text-red-400">
                      {tierErrors.description}
                    </span>
                  ) : null}
                </label>
                <label className="block text-xs">
                  <span className="mb-1 block text-neutral-400">Срок по умолчанию (дней)</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    step="1"
                    min={VIP_TIER_DEFAULT_DAYS_MIN}
                    max={VIP_TIER_DEFAULT_DAYS_MAX}
                    aria-label="Срок по умолчанию (дней)"
                    value={tierForm.defaultDays}
                    onChange={(e) => updateTierField('defaultDays', e.target.value)}
                    className={`w-full rounded border bg-neutral-900 px-2 py-1.5 text-sm ${
                      tierErrors.defaultDays ? 'border-red-800' : 'border-neutral-800'
                    }`}
                  />
                  <span className="mt-1 block text-[11px] text-neutral-500">
                    Пустое поле — бессрочный тир.
                  </span>
                  {tierErrors.defaultDays ? (
                    <span className="mt-1 block text-[11px] text-red-400">
                      {tierErrors.defaultDays}
                    </span>
                  ) : null}
                </label>
                <label className="block text-xs">
                  <span className="mb-1 block text-neutral-400">Порядок сортировки</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    step="1"
                    min={VIP_TIER_SORT_ORDER_MIN}
                    max={VIP_TIER_SORT_ORDER_MAX}
                    aria-label="Порядок сортировки"
                    value={tierForm.sortOrder}
                    onChange={(e) => updateTierField('sortOrder', e.target.value)}
                    className={`w-full rounded border bg-neutral-900 px-2 py-1.5 text-sm ${
                      tierErrors.sortOrder ? 'border-red-800' : 'border-neutral-800'
                    }`}
                  />
                  {tierErrors.sortOrder ? (
                    <span className="mt-1 block text-[11px] text-red-400">
                      {tierErrors.sortOrder}
                    </span>
                  ) : null}
                </label>
              </div>
              <label className="mt-3 flex items-center gap-2 text-xs text-neutral-300">
                <input
                  type="checkbox"
                  aria-label="Тир активен"
                  checked={tierForm.isActive}
                  onChange={(e) => updateTierField('isActive', e.target.checked)}
                  className="h-4 w-4 rounded border-neutral-700 bg-neutral-900 text-sky-500"
                />
                Тир активен (виден в магазине)
              </label>
              <div className="mt-4 flex items-center gap-2">
                <button
                  type="button"
                  onClick={saveTier}
                  disabled={tierSaving}
                  className="rounded-md border border-sky-700 bg-sky-950 px-4 py-2 text-sm text-sky-200 hover:bg-sky-900 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {tierSaving ? 'Сохраняем…' : 'Сохранить тир'}
                </button>
                <button
                  type="button"
                  onClick={cancelTierForm}
                  className="rounded-md border border-neutral-800 px-4 py-2 text-sm text-neutral-300 hover:bg-neutral-900"
                >
                  Отмена
                </button>
              </div>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
