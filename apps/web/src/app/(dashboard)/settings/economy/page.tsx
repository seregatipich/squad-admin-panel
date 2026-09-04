'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  AlertDialog,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  EmptyState,
  FieldRow,
  GroupedList,
  GroupedRow,
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
  Textarea,
  TextInput,
  Th,
  TrashIcon,
} from '@/components/ui';
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
  site_vip_binding_protected:
    'Привязка BSS VIP защищена: её роль и тариф нельзя использовать для другого магазина.',
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
  const [pendingTierDelete, setPendingTierDelete] = useState<VipTier | null>(null);
  const [tierDeleting, setTierDeleting] = useState(false);

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
    setTierErr(null);
    setTierDeleting(true);
    try {
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
    } finally {
      setTierDeleting(false);
      setPendingTierDelete(null);
    }
  }

  const loading = !settings || !form || !me;
  const roleNameById = new Map(roleOptions.map((r) => [r.id, r.name]));

  return (
    <>
      <PageHeader
        title="Экономика организации"
        subtitle="Коэффициенты начисления бонусов и порог сида. Изменения влияют только на будущие начисления — уже начисленные бонусы не пересчитываются."
      />

      <InlineBanner
        tone="warn"
        title="Монетизационная механика"
        description={
          <>
            Экономика бонусов — это механика монетизации. По умолчанию она{' '}
            <span className="font-semibold">выключена</span>. Пока переключатель ниже выключен,
            воркер начислений не работает и связанные блоки интерфейса скрыты.
          </>
        }
      />

      {globalErr ? <InlineBanner tone="crit" title={globalErr} /> : null}
      {notice ? <InlineBanner tone="good" title={notice} /> : null}
      {!loading && !canManage ? (
        <InlineBanner
          tone="info"
          title="Только просмотр"
          description="Просмотр доступен, но для изменения настроек нужно право «Управление экономикой»."
        />
      ) : null}

      {loading || !form || !settings ? (
        <Card>
          <Skeleton variant="row" count={4} label="Загрузка настроек экономики" />
        </Card>
      ) : (
        <>
          <GroupedList>
            <GroupedRow
              label="Экономика включена"
              description="Разрешить воркеру начислять бонусы игрокам за онлайн, буст и сид."
              control={
                <>
                  <Badge tone={form.economyEnabled ? 'good' : 'neutral'}>
                    {form.economyEnabled ? 'Начисления активны' : 'Начисления выключены'}
                  </Badge>
                  <Switch
                    label="Экономика включена"
                    checked={form.economyEnabled}
                    disabled={!canManage}
                    onChange={(next) => updateField('economyEnabled', next)}
                  />
                </>
              }
            />
          </GroupedList>

          <Card padding="none" as="section">
            <CardHeader title="Коэффициенты начисления" />
            <CardBody className="space-y-4">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                {COEFFICIENT_FIELDS.map((field) => (
                  <FieldRow
                    key={field.key}
                    label={field.label}
                    hint={field.hint}
                    error={errors[field.key]}
                  >
                    <TextInput
                      type="number"
                      inputMode="decimal"
                      step="0.1"
                      min={0}
                      value={form[field.key]}
                      disabled={!canManage}
                      invalid={Boolean(errors[field.key])}
                      onChange={(e) => updateField(field.key, e.target.value)}
                    />
                  </FieldRow>
                ))}
              </div>

              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <FieldRow
                  label="Порог сида (игроков), seed_threshold"
                  hint="Если на сервере меньше этого числа игроков, время засчитывается как сид."
                  error={errors.seedThreshold}
                >
                  <TextInput
                    type="number"
                    inputMode="numeric"
                    step="1"
                    min={SEED_THRESHOLD_MIN}
                    max={SEED_THRESHOLD_MAX}
                    value={form.seedThreshold}
                    disabled={!canManage}
                    invalid={Boolean(errors.seedThreshold)}
                    onChange={(e) => updateField('seedThreshold', e.target.value)}
                  />
                </FieldRow>
              </div>
            </CardBody>
          </Card>

          <section aria-label="Напоминания об истечении VIP">
            <Card padding="none">
              <CardHeader title="Напоминания об истечении VIP" />
              <CardBody className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <FieldRow
                  label="Окна напоминаний (дней, через запятую)"
                  hint="За сколько дней до истечения VIP напоминать. Каждое окно срабатывает один раз; продление роли выдаёт напоминания заново."
                  error={errors.vipExpiryWindows}
                >
                  <TextInput
                    value={form.vipExpiryWindows}
                    disabled={!canManage}
                    invalid={Boolean(errors.vipExpiryWindows)}
                    onChange={(e) => updateField('vipExpiryWindows', e.target.value)}
                  />
                </FieldRow>
                <div className="space-y-1">
                  <Checkbox
                    label="Предупреждать игрока в игре"
                    checked={form.vipExpiryWarnInGame}
                    disabled={!canManage}
                    onChange={(e) => updateField('vipExpiryWarnInGame', e.target.checked)}
                  />
                  <p className="text-xs text-ink-3">
                    Разовый AdminWarn «VIP истекает через N дн.» при следующем заходе на сервер.
                  </p>
                </div>
              </CardBody>
            </Card>
          </section>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-xs text-ink-3">
              Последнее изменение: {formatUpdatedAt(settings.updated_at)}
            </span>
            {canManage ? (
              <Button variant="primary" onClick={save} loading={saving}>
                Сохранить
              </Button>
            ) : null}
          </div>

          {canEditTiers ? (
            <section aria-label="VIP-тиры" className="space-y-4">
              <Card padding="none">
                <CardHeader
                  title="VIP-тиры"
                  count={tiers.length > 0 ? tiers.length : undefined}
                  description="Каталог VIP-привилегий. Тир связывает роль с описанием и сроком по умолчанию; деактивация скрывает тир из магазина, не снимая уже выданные роли."
                  actions={
                    tierForm === null ? (
                      <Button variant="primary" size="sm" onClick={startTierCreate}>
                        Добавить тир
                      </Button>
                    ) : null
                  }
                />

                {tierErr ? (
                  <CardBody padding="sm">
                    <InlineBanner tone="crit" title={tierErr} />
                  </CardBody>
                ) : null}

                {tiers.length === 0 ? (
                  <EmptyState
                    title="Тиров пока нет"
                    description="Добавьте первый тир — до этого магазин VIP пуст."
                  />
                ) : (
                  <Table ariaLabel="VIP-тиры">
                    <TableHead>
                      <tr>
                        <Th>Название</Th>
                        <Th>Роль</Th>
                        <Th>Срок</Th>
                        <Th align="right">Порядок</Th>
                        <Th>Состояние</Th>
                        <Th align="right">Действия</Th>
                      </tr>
                    </TableHead>
                    <TableBody>
                      {tiers.map((tier) => (
                        <TableRow key={tier.id}>
                          <Td>
                            <span className="font-medium">{tier.name}</span>
                            {tier.description ? (
                              <span className="mt-0.5 block text-xs text-ink-3">
                                {tier.description}
                              </span>
                            ) : null}
                          </Td>
                          <Td className="text-ink-2">
                            {roleNameById.get(tier.role_id) ?? tier.role_id}
                          </Td>
                          <Td className="text-ink-2">{formatTierDuration(tier.default_days)}</Td>
                          <Td numeric className="text-ink-3">
                            {tier.sort_order}
                          </Td>
                          <Td>
                            <Badge tone={tier.is_active ? 'good' : 'neutral'} size="sm">
                              {tier.is_active ? 'Активен' : 'Скрыт'}
                            </Badge>
                          </Td>
                          <Td align="right">
                            <div className="flex items-center justify-end gap-2">
                              <Button size="sm" onClick={() => startTierEdit(tier)}>
                                Редактировать
                              </Button>
                              <IconButton
                                icon={<TrashIcon />}
                                label={`Удалить тир «${tier.name}»`}
                                size="sm"
                                tone="destructive"
                                onClick={() => setPendingTierDelete(tier)}
                              />
                            </div>
                          </Td>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </Card>

              {tierForm ? (
                <Card padding="none">
                  <CardHeader
                    title={editingTierId ? 'Редактирование тира' : 'Новый тир'}
                    headingLevel={3}
                  />
                  <CardBody className="space-y-4">
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                      <FieldRow label="Название" error={tierErrors.name}>
                        <TextInput
                          maxLength={VIP_TIER_NAME_MAX}
                          value={tierForm.name}
                          invalid={Boolean(tierErrors.name)}
                          onChange={(e) => updateTierField('name', e.target.value)}
                        />
                      </FieldRow>
                      <FieldRow label="Роль" error={tierErrors.roleId}>
                        <Select
                          value={tierForm.roleId}
                          invalid={Boolean(tierErrors.roleId)}
                          onChange={(e) => updateTierField('roleId', e.target.value)}
                        >
                          <option value="">— выберите роль —</option>
                          {roleOptions.map((r) => (
                            <option key={r.id} value={r.id}>
                              {r.name}
                            </option>
                          ))}
                        </Select>
                      </FieldRow>
                      <FieldRow
                        label="Описание"
                        error={tierErrors.description}
                        className="md:col-span-2"
                      >
                        <Textarea
                          rows={2}
                          value={tierForm.description}
                          invalid={Boolean(tierErrors.description)}
                          onChange={(e) => updateTierField('description', e.target.value)}
                        />
                      </FieldRow>
                      <FieldRow
                        label="Срок по умолчанию (дней)"
                        hint="Пустое поле — бессрочный тир."
                        error={tierErrors.defaultDays}
                      >
                        <TextInput
                          type="number"
                          inputMode="numeric"
                          step="1"
                          min={VIP_TIER_DEFAULT_DAYS_MIN}
                          max={VIP_TIER_DEFAULT_DAYS_MAX}
                          value={tierForm.defaultDays}
                          invalid={Boolean(tierErrors.defaultDays)}
                          onChange={(e) => updateTierField('defaultDays', e.target.value)}
                        />
                      </FieldRow>
                      <FieldRow label="Порядок сортировки" error={tierErrors.sortOrder}>
                        <TextInput
                          type="number"
                          inputMode="numeric"
                          step="1"
                          min={VIP_TIER_SORT_ORDER_MIN}
                          max={VIP_TIER_SORT_ORDER_MAX}
                          value={tierForm.sortOrder}
                          invalid={Boolean(tierErrors.sortOrder)}
                          onChange={(e) => updateTierField('sortOrder', e.target.value)}
                        />
                      </FieldRow>
                    </div>
                    <div className="space-y-1">
                      <Checkbox
                        label="Тир активен"
                        checked={tierForm.isActive}
                        onChange={(e) => updateTierField('isActive', e.target.checked)}
                      />
                      <p className="text-xs text-ink-3">Активный тир виден в магазине.</p>
                    </div>
                    <div className="flex items-center justify-end gap-2">
                      <Button variant="secondary" onClick={cancelTierForm}>
                        Отмена
                      </Button>
                      <Button variant="primary" onClick={saveTier} loading={tierSaving}>
                        Сохранить тир
                      </Button>
                    </div>
                  </CardBody>
                </Card>
              ) : null}
            </section>
          ) : null}
        </>
      )}

      <AlertDialog
        open={pendingTierDelete !== null}
        onClose={() => setPendingTierDelete(null)}
        title="Удалить VIP-тир"
        body={
          pendingTierDelete
            ? `Тир «${pendingTierDelete.name}» будет удалён из каталога без возможности восстановления. Уже выданные роли останутся у игроков.`
            : ''
        }
        confirmLabel="Удалить тир"
        cancelLabel="Отмена"
        tone="destructive"
        busy={tierDeleting}
        onConfirm={() => {
          if (pendingTierDelete) void removeTier(pendingTierDelete);
        }}
      />
    </>
  );
}
