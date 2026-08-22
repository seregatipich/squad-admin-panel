'use client';

import { buildManagedSegmentBody } from '@squad/shared-config/admins-config';
import type { RoleColor } from '@squad/shared-config/role-colors';
import {
  SQUAD_PERMISSIONS,
  type SquadPermissionDef,
  type SquadPermissionKey,
} from '@squad/shared-config/squad-permissions';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { RoleColorDot } from '@/components/RoleColorDot';
import {
  AlertDialog,
  Badge,
  Button,
  ButtonLink,
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
  TextInput,
  TrashIcon,
} from '@/components/ui';

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const SAVE_DEBOUNCE_MS = 500;

interface RoleRow {
  id: string;
  name: string;
  color: string;
  description: string | null;
  is_system_role: boolean;
  panel_access: boolean;
  can_view_ips: boolean;
  can_assign_roles: boolean;
  can_edit_roles: boolean;
  can_manage_ban_sources: boolean;
  can_manage_clans: boolean;
  can_manage_economy: boolean;
  squad_permissions: SquadPermissionKey[];
  assigned_users_count: number;
}

interface Me {
  permissions: string[];
}

/** Флаги доступа роли в панели. `panel_access` — ворота ко всем остальным. */
type FlagKey =
  | 'panel_access'
  | 'can_view_ips'
  | 'can_assign_roles'
  | 'can_edit_roles'
  | 'can_manage_ban_sources'
  | 'can_manage_clans'
  | 'can_manage_economy';

const ACCESS_FLAGS: ReadonlyArray<{ key: FlagKey; label: string; description?: string }> = [
  {
    key: 'panel_access',
    label: 'Доступ к панели',
    description: 'Без него остальные флаги ничего не дают и выключаются вместе с ним.',
  },
  { key: 'can_view_ips', label: 'Видит историю IP' },
  { key: 'can_assign_roles', label: 'Может выдавать роли' },
  { key: 'can_edit_roles', label: 'Может редактировать роли' },
  { key: 'can_manage_ban_sources', label: 'Может управлять источниками банов' },
  { key: 'can_manage_clans', label: 'Может управлять кланами' },
  { key: 'can_manage_economy', label: 'Может управлять экономикой' },
];

function chunk<T>(arr: readonly T[], cols: number): T[][] {
  const perCol = Math.ceil(arr.length / cols);
  const out: T[][] = Array.from({ length: cols }, () => []);
  arr.forEach((item, idx) => {
    const c = Math.floor(idx / perCol);
    if (c < cols) out[c]?.push(item);
  });
  return out;
}

export default function GroupsPage() {
  const [rows, setRows] = useState<RoleRow[] | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [globalErr, setGlobalErr] = useState<string | null>(null);
  const [savingByRole, setSavingByRole] = useState<Record<string, boolean>>({});
  const [presetRoleId, setPresetRoleId] = useState('');
  const [pendingDelete, setPendingDelete] = useState<RoleRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  const refresh = useCallback(async () => {
    const [rolesRes, meRes] = await Promise.all([
      fetch('/api/v1/roles', { credentials: 'include', cache: 'no-store' }),
      fetch('/api/v1/me', { credentials: 'include', cache: 'no-store' }),
    ]);
    if (rolesRes.ok) setRows((await rolesRes.json()) as RoleRow[]);
    if (meRes.ok) setMe((await meRes.json()) as Me);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const canEdit = me?.permissions.includes('role:edit') ?? false;
  const canCreate = me?.permissions.includes('role:create') ?? false;
  const canDelete = me?.permissions.includes('role:delete') ?? false;

  function applyLocalUpdate(roleId: string, patch: Partial<RoleRow>) {
    setRows((prev) => (prev ? prev.map((r) => (r.id === roleId ? { ...r, ...patch } : r)) : prev));
  }

  async function saveRolePatch(role: RoleRow, patch: Partial<RoleRow>) {
    setSavingByRole((p) => ({ ...p, [role.id]: true }));
    setGlobalErr(null);
    try {
      const body: Record<string, unknown> = {};
      if (patch.name !== undefined) body.name = patch.name;
      if (patch.color !== undefined) body.color = patch.color;
      if (patch.panel_access !== undefined) body.panel_access = patch.panel_access;
      if (patch.can_view_ips !== undefined) body.can_view_ips = patch.can_view_ips;
      if (patch.can_assign_roles !== undefined) body.can_assign_roles = patch.can_assign_roles;
      if (patch.can_edit_roles !== undefined) body.can_edit_roles = patch.can_edit_roles;
      if (patch.can_manage_ban_sources !== undefined)
        body.can_manage_ban_sources = patch.can_manage_ban_sources;
      if (patch.can_manage_clans !== undefined) body.can_manage_clans = patch.can_manage_clans;
      if (patch.can_manage_economy !== undefined)
        body.can_manage_economy = patch.can_manage_economy;
      if (patch.squad_permissions !== undefined) body.squad_permissions = patch.squad_permissions;
      const res = await fetch(`/api/v1/roles/${role.id}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}) as Record<string, unknown>);
        setGlobalErr(`Ошибка сохранения роли «${role.name}»: ${err.error ?? res.status}`);
        await refresh();
        return;
      }
      const fresh = (await res.json()) as RoleRow;
      setRows((prev) => (prev ? prev.map((r) => (r.id === role.id ? fresh : r)) : prev));
    } catch (err) {
      setGlobalErr(`Ошибка сети: ${(err as Error).message}`);
      await refresh();
    } finally {
      setSavingByRole((p) => ({ ...p, [role.id]: false }));
    }
  }

  async function createRole() {
    setGlobalErr(null);
    const preset = presetRoleId ? rows?.find((r) => r.id === presetRoleId) : undefined;
    const body = {
      name: 'Новая роль',
      color: '#737373',
      squad_permissions: preset ? [...preset.squad_permissions] : [],
      panel_access: false,
      can_view_ips: false,
      can_assign_roles: false,
      can_edit_roles: false,
      can_manage_ban_sources: false,
      can_manage_clans: false,
      can_manage_economy: false,
    };
    let attempt = 0;
    while (attempt < 5) {
      const trial = attempt === 0 ? body : { ...body, name: `Новая роль ${attempt + 1}` };
      const res = await fetch('/api/v1/roles', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(trial),
      });
      if (res.ok) {
        await refresh();
        return;
      }
      if (res.status === 409) {
        attempt += 1;
        continue;
      }
      const err = await res.json().catch(() => ({}) as Record<string, unknown>);
      setGlobalErr(`Ошибка создания: ${err.error ?? res.status}`);
      return;
    }
    setGlobalErr('Не удалось придумать уникальное имя — переименуйте существующие роли.');
  }

  async function removeRole(role: RoleRow) {
    if (!canDelete) return;
    setDeleting(true);
    setGlobalErr(null);
    try {
      const res = await fetch(`/api/v1/roles/${role.id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}) as Record<string, unknown>);
        setGlobalErr(`Ошибка удаления: ${err.error ?? res.status}`);
        return;
      }
      await refresh();
    } finally {
      setDeleting(false);
      setPendingDelete(null);
    }
  }

  return (
    <>
      <PageHeader
        title="Группы и роли"
        subtitle={
          <>
            Inline-редактор ролей и прав. Изменения сразу синхронизируются с Admins.cfg на всех
            серверах.{' '}
            <a
              className="text-accent no-underline hover:brightness-110"
              href="https://squad.fandom.com/wiki/Server_Administration"
              target="_blank"
              rel="noreferrer"
            >
              Больше информации по правам
            </a>
            .
          </>
        }
        actions={
          canCreate ? (
            <>
              <Select
                aria-label="Скопировать права из роли"
                value={presetRoleId}
                onChange={(e) => setPresetRoleId(e.target.value)}
                className="w-64"
              >
                <option value="">Без пресета (пустая)</option>
                {(rows ?? []).map((r) => (
                  <option key={r.id} value={r.id}>
                    Скопировать права из «{r.name}»
                  </option>
                ))}
              </Select>
              <Button variant="primary" onClick={() => void createRole()}>
                Создать роль
              </Button>
            </>
          ) : null
        }
      />

      {globalErr ? (
        <InlineBanner
          tone="crit"
          title={globalErr}
          onDismiss={() => setGlobalErr(null)}
          dismissLabel="Скрыть сообщение"
        />
      ) : null}

      {!rows || !me ? (
        <Skeleton variant="card" count={3} label="Загрузка списка ролей" />
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState
            title="Ролей пока нет"
            description="Создайте первую роль, чтобы выдавать доступ к панели и права на серверах."
          />
        </Card>
      ) : (
        rows.map((role) => (
          <RoleCard
            key={role.id}
            role={role}
            canEdit={canEdit && !(role.is_system_role && role.name === 'Owner')}
            canDelete={canDelete && !(role.is_system_role && role.name === 'Owner')}
            saving={!!savingByRole[role.id]}
            onLocal={(patch) => applyLocalUpdate(role.id, patch)}
            onSave={(patch) => saveRolePatch(role, patch)}
            onDelete={() => setPendingDelete(role)}
          />
        ))
      )}

      {/* Единственное необратимо разрушающее действие раздела: роль исчезает
          вместе с назначениями, и Admins.cfg переписывается на всех серверах.
          Поэтому и критический тон, и ввод имени роли — набрать его случайно
          нельзя (дизайн-система, §5). */}
      <AlertDialog
        open={pendingDelete !== null}
        onClose={() => {
          if (deleting) return;
          setPendingDelete(null);
        }}
        title="Удалить роль"
        body={
          pendingDelete
            ? `Роль «${pendingDelete.name}» будет удалена. Её потеряют ${pendingDelete.assigned_users_count} пользователей, и Admins.cfg пересинхронизируется на всех серверах. Восстановить роль нельзя.`
            : ''
        }
        confirmLabel="Удалить роль"
        cancelLabel="Отмена"
        tone="destructive"
        busy={deleting}
        challenge={
          pendingDelete
            ? {
                expected: pendingDelete.name,
                label: 'Введите имя роли, чтобы подтвердить',
                hint: `Ожидается: ${pendingDelete.name}`,
              }
            : undefined
        }
        onConfirm={() => {
          if (pendingDelete) void removeRole(pendingDelete);
        }}
      />
    </>
  );
}

function RoleCard({
  role,
  canEdit,
  canDelete,
  saving,
  onLocal,
  onSave,
  onDelete,
}: {
  role: RoleRow;
  canEdit: boolean;
  canDelete: boolean;
  saving: boolean;
  onLocal: (patch: Partial<RoleRow>) => void;
  onSave: (patch: Partial<RoleRow>) => void;
  onDelete: () => void;
}) {
  const uid = useId();
  const colorInputId = `${uid}-color`;
  const debouncerRef = useRef<{
    patch: Partial<RoleRow>;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const debounce = useCallback(
    (patch: Partial<RoleRow>) => {
      const next = { ...(debouncerRef.current?.patch ?? {}), ...patch };
      if (debouncerRef.current?.timer) clearTimeout(debouncerRef.current.timer);
      const timer = setTimeout(() => {
        debouncerRef.current = null;
        onSave(next);
      }, SAVE_DEBOUNCE_MS);
      debouncerRef.current = { patch: next, timer };
    },
    [onSave],
  );

  const [permFilter, setPermFilter] = useState('');
  const permGrid = useMemo(() => {
    const q = permFilter.trim().toLowerCase();
    const all = SQUAD_PERMISSIONS as readonly SquadPermissionDef[];
    const filtered = q
      ? all.filter(
          (p) =>
            p.key.toLowerCase().includes(q) ||
            p.label.toLowerCase().includes(q) ||
            p.description.toLowerCase().includes(q),
        )
      : all;
    return { filtered, columns: chunk(filtered, 3) };
  }, [permFilter]);

  const togglePerm = (key: SquadPermissionKey) => {
    if (!canEdit) return;
    const has = role.squad_permissions.includes(key);
    const next = has
      ? role.squad_permissions.filter((k) => k !== key)
      : [...role.squad_permissions, key];
    onLocal({ squad_permissions: next });
    debounce({ squad_permissions: next });
  };

  const setFlag = (key: FlagKey, value: boolean) => {
    if (!canEdit) return;
    const patch: Partial<RoleRow> = { [key]: value } as Partial<RoleRow>;
    if (key === 'panel_access' && !value) {
      patch.can_view_ips = false;
      patch.can_assign_roles = false;
      patch.can_edit_roles = false;
      patch.can_manage_ban_sources = false;
      patch.can_manage_clans = false;
      patch.can_manage_economy = false;
    }
    onLocal(patch);
    debounce(patch);
  };

  const setName = (name: string) => {
    if (!canEdit) return;
    onLocal({ name });
    debounce({ name });
  };

  const setColor = (color: string) => {
    if (!canEdit) return;
    if (!HEX_RE.test(color)) {
      // intermediate keystroke (e.g. user is typing a hex value) — show
      // it locally without persisting.
      onLocal({ color });
      return;
    }
    onLocal({ color });
    debounce({ color });
  };

  const isOwner = role.is_system_role && role.name === 'Owner';

  return (
    <Card as="section" padding="none">
      <CardHeader
        title={
          <span className="inline-flex items-center gap-2">
            <RoleColorDot color={role.color as RoleColor | string} />
            {role.name}
          </span>
        }
        actions={
          <>
            {saving ? <span className="text-xs text-ink-3">Сохраняем…</span> : null}
            {isOwner ? <Badge>Системная</Badge> : null}
            <ButtonLink href={`/settings/groups/${role.id}/members`} size="sm">
              Участники ({role.assigned_users_count})
            </ButtonLink>
            {canDelete ? (
              <IconButton
                icon={<TrashIcon />}
                label="Удалить роль"
                tone="destructive"
                onClick={onDelete}
              />
            ) : null}
          </>
        }
      />

      <CardBody className="space-y-6">
        {isOwner ? (
          <InlineBanner
            tone="warn"
            title="Системная роль"
            description="Имя, цвет и права нельзя редактировать через интерфейс — Owner всегда имеет все 3 флага доступа и все 21 Squad permission."
          />
        ) : null}

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <FieldRow label="Название">
            <TextInput
              value={role.name}
              disabled={!canEdit}
              onChange={(e) => setName(e.target.value)}
            />
          </FieldRow>
          {/* Образец цвета — нативный `<input type="color">`: примитива под него
              в дизайн-системе нет, а `TextInput` растянул бы его во всю строку. */}
          <div className="flex flex-col gap-1">
            <label htmlFor={colorInputId} className="text-xs font-medium text-ink-2">
              Цвет
            </label>
            <input
              id={colorInputId}
              type="color"
              value={HEX_RE.test(role.color) ? role.color : '#737373'}
              disabled={!canEdit}
              onChange={(e) => setColor(e.target.value.toUpperCase())}
              className="h-8 w-12 cursor-pointer rounded-ctl border border-line bg-raised disabled:cursor-not-allowed disabled:opacity-40"
            />
          </div>
          <FieldRow label="HEX">
            <TextInput
              value={role.color}
              disabled={!canEdit}
              onChange={(e) => setColor(e.target.value)}
              className="font-mono uppercase"
            />
          </FieldRow>
        </div>

        <GroupedList title="Доступ к панели" headingLevel={3}>
          {ACCESS_FLAGS.map((flag) => (
            <GroupedRow
              key={flag.key}
              label={flag.label}
              description={flag.description}
              control={
                <Switch
                  label={flag.label}
                  checked={role[flag.key]}
                  disabled={!canEdit || (flag.key !== 'panel_access' && !role.panel_access)}
                  onChange={(value) => setFlag(flag.key, value)}
                />
              }
            />
          ))}
        </GroupedList>

        <section className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-[13px] font-semibold text-ink">Squad permissions</h3>
            {/* Фильтр работает по массиву из 21 элемента, поэтому это обычное
                поле, а не `SearchField`: отложенная отправка нужна запросу в
                базу, а здесь она была бы задержкой ради задержки. */}
            <div className="w-48">
              <TextInput
                type="search"
                size="sm"
                value={permFilter}
                onChange={(e) => setPermFilter(e.target.value)}
                placeholder="Фильтр прав…"
                aria-label="Фильтр прав"
              />
            </div>
          </div>
          {permGrid.filtered.length === 0 ? (
            <EmptyState
              variant="filtered"
              title={`Ничего не найдено по фильтру «${permFilter}»`}
              description="Проверьте написание или очистите фильтр."
              action={
                <Button size="sm" onClick={() => setPermFilter('')}>
                  Сбросить фильтр
                </Button>
              }
            />
          ) : (
            <div className="grid grid-cols-1 gap-1 md:grid-cols-3">
              {permGrid.columns.map((col, idx) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: layout columns are stable
                <ul key={idx} className="space-y-1">
                  {col.map((perm) => {
                    const permKey = perm.key as SquadPermissionKey;
                    return (
                      <li key={perm.key}>
                        <Checkbox
                          checked={role.squad_permissions.includes(permKey)}
                          disabled={!canEdit}
                          onChange={() => togglePerm(permKey)}
                          label={
                            <span
                              className="inline-flex items-center gap-1"
                              title={perm.description}
                            >
                              <span className="font-mono">{perm.label}</span>
                              {perm.dangerous ? (
                                <span className="text-warn" title="Опасное право">
                                  <span aria-hidden="true">⚠</span>
                                  <span className="sr-only">опасное право</span>
                                </span>
                              ) : null}
                            </span>
                          }
                        />
                      </li>
                    );
                  })}
                </ul>
              ))}
            </div>
          )}
        </section>

        <details className="text-xs text-ink-3">
          <summary className="cursor-pointer transition-colors duration-150 hover:text-ink">
            Как это выглядит в Admins.cfg
          </summary>
          <pre
            data-testid="admins-cfg-preview"
            className="mt-2 overflow-auto rounded-ctl border border-line bg-bg p-2 font-mono text-2xs text-ink-2"
          >
            {
              buildManagedSegmentBody({
                roles: [{ name: role.name, squadPermissions: role.squad_permissions }],
                admins: [],
              }).body
            }
          </pre>
          <p className="mt-1 text-2xs text-ink-3">
            Рендер из того же генератора, что и config-sync (SYNC-2) — побайтно совпадает с файлом.
            {role.squad_permissions.length === 0
              ? ' У роли нет Squad permissions, поэтому строка Group= не пишется.'
              : ''}
          </p>
        </details>
      </CardBody>
    </Card>
  );
}
