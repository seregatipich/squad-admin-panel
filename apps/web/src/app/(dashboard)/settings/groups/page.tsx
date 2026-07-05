'use client';

import type { RoleColor } from '@squad/shared-config/role-colors';
import {
  SQUAD_PERMISSIONS,
  type SquadPermissionDef,
  type SquadPermissionKey,
} from '@squad/shared-config/squad-permissions';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { RoleColorDot } from '@/components/RoleColorDot';

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const SAVE_DEBOUNCE_MS = 500;

interface RoleRow {
  id: string;
  name: string;
  color: string;
  description: string | null;
  is_system_role: boolean;
  panel_access: boolean;
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

const PERM_GRID = chunk(SQUAD_PERMISSIONS as readonly SquadPermissionDef[], 3);

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
    const body = {
      name: 'Новая роль',
      color: '#737373',
      squad_permissions: [],
      panel_access: false,
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
    if (
      !confirm(
        `Удалить роль «${role.name}»? Это снимет роль у ${role.assigned_users_count} пользователей и пересинхронизирует Admins.cfg на всех серверах.`,
      )
    )
      return;
    setGlobalErr(null);
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
  }

  if (!rows || !me) return <div className="text-neutral-500">Загрузка…</div>;

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Группы и роли</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Inline-редактор ролей и прав. Изменения сразу синхронизируются с Admins.cfg на всех
            серверах.{' '}
            <a
              className="text-sky-400 hover:text-sky-300"
              href="https://squad.fandom.com/wiki/Server_Administration"
              target="_blank"
              rel="noreferrer"
            >
              Больше информации по правам
            </a>
            .
          </p>
        </div>
        {canCreate ? (
          <button
            type="button"
            onClick={createRole}
            className="rounded-md border border-sky-700 bg-sky-950 px-3 py-1.5 text-sm text-sky-200 hover:bg-sky-900"
          >
            + Создать роль
          </button>
        ) : null}
      </header>

      {globalErr ? (
        <div className="rounded border border-red-900 bg-red-950 p-3 text-sm text-red-200">
          {globalErr}
        </div>
      ) : null}

      <div className="space-y-4">
        {rows.map((role) => (
          <RoleCard
            key={role.id}
            role={role}
            canEdit={canEdit && !(role.is_system_role && role.name === 'Owner')}
            canDelete={canDelete && !(role.is_system_role && role.name === 'Owner')}
            saving={!!savingByRole[role.id]}
            onLocal={(patch) => applyLocalUpdate(role.id, patch)}
            onSave={(patch) => saveRolePatch(role, patch)}
            onDelete={() => removeRole(role)}
          />
        ))}
      </div>
    </div>
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

  const togglePerm = (key: SquadPermissionKey) => {
    if (!canEdit) return;
    const has = role.squad_permissions.includes(key);
    const next = has
      ? role.squad_permissions.filter((k) => k !== key)
      : [...role.squad_permissions, key];
    onLocal({ squad_permissions: next });
    debounce({ squad_permissions: next });
  };

  const setFlag = (
    key:
      | 'panel_access'
      | 'can_assign_roles'
      | 'can_edit_roles'
      | 'can_manage_ban_sources'
      | 'can_manage_clans'
      | 'can_manage_economy',
    value: boolean,
  ) => {
    if (!canEdit) return;
    const patch: Partial<RoleRow> = { [key]: value } as Partial<RoleRow>;
    if (key === 'panel_access' && !value) {
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
    <section className="rounded-lg border border-neutral-800 bg-neutral-950 p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <RoleColorDot color={role.color as RoleColor | string} />
          <h2 className="text-lg font-semibold">{role.name}</h2>
          {isOwner ? (
            <span className="rounded bg-red-950 px-2 py-0.5 text-[10px] uppercase text-red-300">
              system
            </span>
          ) : null}
          {saving ? <span className="text-xs text-neutral-500">сохраняем…</span> : null}
        </div>
        <div className="flex items-center gap-2">
          <Link
            href={`/settings/groups/${role.id}/members`}
            className="text-xs text-sky-400 hover:text-sky-300"
          >
            Открыть список членов ({role.assigned_users_count}) →
          </Link>
          {canDelete ? (
            <button
              type="button"
              onClick={onDelete}
              title="Удалить роль"
              className="rounded border border-red-900 px-2 py-0.5 text-xs text-red-300 hover:bg-red-950"
            >
              ⌫
            </button>
          ) : null}
        </div>
      </div>

      {isOwner ? (
        <div className="mt-3 rounded border border-amber-900 bg-amber-950/40 p-2 text-xs text-amber-200">
          Системная роль. Имя, цвет и permissions нельзя редактировать через UI — Owner всегда имеет
          все 3 флага доступа и все 21 Squad permission.
        </div>
      ) : null}

      <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
        <label className="block text-xs">
          <span className="mb-1 block text-neutral-400">📝 Название</span>
          <input
            type="text"
            value={role.name}
            disabled={!canEdit}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-60"
          />
        </label>
        <label className="block text-xs">
          <span className="mb-1 block text-neutral-400">🎨 Цвет</span>
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={HEX_RE.test(role.color) ? role.color : '#737373'}
              disabled={!canEdit}
              onChange={(e) => setColor(e.target.value.toUpperCase())}
              className="h-8 w-10 cursor-pointer rounded border border-neutral-800 bg-neutral-900 disabled:cursor-not-allowed"
            />
            <input
              type="text"
              value={role.color}
              disabled={!canEdit}
              onChange={(e) => setColor(e.target.value)}
              className="w-28 rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 font-mono text-sm uppercase disabled:cursor-not-allowed disabled:opacity-60"
            />
          </div>
        </label>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-2 text-sm md:grid-cols-2 lg:grid-cols-4">
        <FlagSwitch
          label="🖥️ Доступ к панели"
          enabled={role.panel_access}
          disabled={!canEdit}
          onChange={(v) => setFlag('panel_access', v)}
        />
        <FlagSwitch
          label="👥 Может выдавать роли"
          enabled={role.can_assign_roles}
          disabled={!canEdit || !role.panel_access}
          onChange={(v) => setFlag('can_assign_roles', v)}
        />
        <FlagSwitch
          label="⚙️ Может редактировать роли"
          enabled={role.can_edit_roles}
          disabled={!canEdit || !role.panel_access}
          onChange={(v) => setFlag('can_edit_roles', v)}
        />
        <FlagSwitch
          label="🛡️ Может управлять источниками банов"
          enabled={role.can_manage_ban_sources}
          disabled={!canEdit || !role.panel_access}
          onChange={(v) => setFlag('can_manage_ban_sources', v)}
        />
        <FlagSwitch
          label="🏳️ Может управлять кланами"
          enabled={role.can_manage_clans}
          disabled={!canEdit || !role.panel_access}
          onChange={(v) => setFlag('can_manage_clans', v)}
        />
        <FlagSwitch
          label="💰 Может управлять экономикой"
          enabled={role.can_manage_economy}
          disabled={!canEdit || !role.panel_access}
          onChange={(v) => setFlag('can_manage_economy', v)}
        />
      </div>

      <div className="mt-5">
        <div className="text-xs uppercase tracking-widest text-neutral-500">
          ≡ Squad permissions
        </div>
        <div className="mt-2 grid grid-cols-1 gap-1 md:grid-cols-3">
          {PERM_GRID.map((col, idx) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: layout columns are stable
            <ul key={idx} className="space-y-1">
              {col.map((perm) => {
                const permKey = perm.key as SquadPermissionKey;
                const active = role.squad_permissions.includes(permKey);
                return (
                  <li key={perm.key}>
                    <label
                      className={`flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 hover:bg-neutral-900/40 ${
                        canEdit ? '' : 'cursor-not-allowed opacity-70'
                      }`}
                      title={perm.description}
                    >
                      <input
                        type="checkbox"
                        checked={active}
                        disabled={!canEdit}
                        onChange={() => togglePerm(permKey)}
                        className="h-4 w-4 rounded border-neutral-700 bg-neutral-900 text-sky-500"
                      />
                      <span className="font-mono text-xs">{perm.label}</span>
                      {perm.dangerous ? (
                        <span title="Dangerous permission" className="text-amber-400">
                          ⚠️
                        </span>
                      ) : null}
                    </label>
                  </li>
                );
              })}
            </ul>
          ))}
        </div>
      </div>

      <details className="mt-4 text-xs text-neutral-500">
        <summary className="cursor-pointer hover:text-neutral-300">
          Как это выглядит в Admins.cfg
        </summary>
        <pre className="mt-2 overflow-auto rounded border border-neutral-900 bg-black p-2 font-mono text-[11px] text-neutral-300">{`Group=${role.name}:${[...role.squad_permissions].sort().join(',') || '(нет permissions — Group= не пишется)'}`}</pre>
      </details>
    </section>
  );
}

function FlagSwitch({
  label,
  enabled,
  disabled,
  onChange,
}: {
  label: string;
  enabled: boolean;
  disabled: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label
      className={`flex cursor-pointer items-center justify-between rounded border border-neutral-800 px-3 py-2 ${
        disabled ? 'cursor-not-allowed opacity-60' : 'hover:bg-neutral-900/60'
      }`}
    >
      <span className="text-xs text-neutral-300">{label}</span>
      <input
        type="checkbox"
        aria-label={label}
        checked={enabled}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="ml-3 h-4 w-9 cursor-pointer appearance-none rounded-full bg-neutral-800 transition-all checked:bg-sky-600 disabled:cursor-not-allowed"
        style={{
          backgroundImage:
            'radial-gradient(circle 7px at 8px center, white 100%, transparent 100%)',
        }}
      />
    </label>
  );
}
