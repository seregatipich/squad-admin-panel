'use client';
import { useCallback, useEffect, useId, useState } from 'react';

/**
 * Panel role → Discord role mapping management (DISCORD-5, #152) on
 * `/settings/integrations/discord`.
 *
 * Gating is self-hide-on-403: `GET /api/v1/me` does not expose a
 * `can_manage_integrations` boolean, and the API already answers 403 without
 * `integration:manage`, so the section simply renders nothing rather than
 * duplicating the permission rule in the client.
 */

export interface RoleMappingRow {
  id: string;
  role_id: string;
  role_name: string | null;
  discord_role_id: string;
  source: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface RoleSyncStatus {
  state: 'ok' | 'error';
  reason: string | null;
  message: string | null;
  checked_at: string;
}

interface RoleOption {
  id: string;
  name: string;
  is_system_role: boolean;
}

/**
 * Turns the worker's last role-sync outcome into the banner text, or `null`
 * when there is nothing to warn about. The `missing_permissions` case gets its
 * own wording because it is the one failure an operator can actually fix, and
 * DISCORD-5's acceptance criteria require it to be visible rather than silent.
 */
export function roleSyncStatusText(status: RoleSyncStatus | null): string | null {
  if (!status || status.state !== 'error') return null;
  if (status.reason === 'missing_permissions') {
    return 'У бота нет права Manage Roles в Discord-гильдии — роли не выдаются.';
  }
  return status.message ?? 'Синхронизация ролей завершилась с ошибкой.';
}

const CREATE_ERRORS: Record<string, string> = {
  role_mapping_exists: 'Для этой роли панели маппинг уже существует',
  role_not_found: 'Роль панели не найдена',
};

const BASE = '/api/v1/integrations/discord/role-mappings';

async function readError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return (body.error && CREATE_ERRORS[body.error]) ?? 'Не удалось сохранить маппинг';
}

export default function DiscordRoleMappingsSection() {
  const roleSelectId = useId();
  const discordRoleInputId = useId();

  const [hidden, setHidden] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [items, setItems] = useState<RoleMappingRow[]>([]);
  const [status, setStatus] = useState<RoleSyncStatus | null>(null);
  const [roleOptions, setRoleOptions] = useState<RoleOption[]>([]);
  const [formRoleId, setFormRoleId] = useState('');
  const [formDiscordRoleId, setFormDiscordRoleId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [mappingsRes, rolesRes] = await Promise.all([
      fetch(BASE, { credentials: 'include', cache: 'no-store' }),
      fetch('/api/v1/roles', { credentials: 'include', cache: 'no-store' }),
    ]);
    if (mappingsRes.status === 403) {
      setHidden(true);
      return;
    }
    if (!mappingsRes.ok) {
      setError('Не удалось загрузить маппинги ролей');
      setLoaded(true);
      return;
    }
    const body = (await mappingsRes.json()) as {
      items: RoleMappingRow[];
      status: RoleSyncStatus | null;
    };
    setItems(body.items);
    setStatus(body.status);
    if (rolesRes.ok) setRoleOptions((await rolesRes.json()) as RoleOption[]);
    setLoaded(true);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (hidden) return null;

  const mappedRoleIds = new Set(items.map((row) => row.role_id));
  const assignableRoles = roleOptions.filter(
    (role) => !(role.is_system_role && role.name === 'Owner') && !mappedRoleIds.has(role.id),
  );

  const statusText = roleSyncStatusText(status);

  async function create() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(BASE, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role_id: formRoleId, discord_role_id: formDiscordRoleId }),
      });
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      setFormRoleId('');
      setFormDiscordRoleId('');
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function toggle(row: RoleMappingRow) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${BASE}/${row.id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: !row.enabled }),
      });
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function remove(row: RoleMappingRow) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${BASE}/${row.id}`, { method: 'DELETE', credentials: 'include' });
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function reconcile() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`${BASE}/reconcile`, { method: 'POST', credentials: 'include' });
      if (!res.ok) {
        setError('Не удалось запустить синхронизацию');
        return;
      }
      setNotice('Синхронизация поставлена в очередь');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-3 rounded border border-neutral-800 bg-neutral-950 p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-xs uppercase tracking-widest text-neutral-400">Синхронизация ролей</h2>
        <button
          type="button"
          onClick={() => void reconcile()}
          disabled={busy}
          className="rounded border border-sky-900 px-3 py-0.5 text-xs text-sky-300 hover:border-sky-700 disabled:opacity-40"
        >
          Синхронизировать сейчас
        </button>
      </div>

      <p className="text-xs text-neutral-500">
        Роль панели выдаёт указанную роль Discord каждому игроку, привязавшему Discord-аккаунт;
        панель — источник истины, расхождения чинит ежечасная сверка. Источник — роль панели; роли
        по лидербордам (топ по киллам, тиры по времени) появятся позже, после STATS-3.
      </p>

      {statusText ? (
        <div className="rounded border border-red-900 bg-red-950 p-3 text-sm text-red-200">
          {statusText}
        </div>
      ) : null}
      {error ? (
        <div className="rounded border border-red-900 bg-red-950 p-3 text-sm text-red-200">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="rounded border border-emerald-900 bg-emerald-950/50 p-3 text-sm text-emerald-200">
          {notice}
        </div>
      ) : null}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase text-neutral-500">
            <tr>
              <th className="py-2 pr-2">Роль панели</th>
              <th className="py-2 pr-2">ID роли Discord</th>
              <th className="py-2 pr-2">Состояние</th>
              <th className="py-2 pr-2" />
            </tr>
          </thead>
          <tbody>
            {items.map((row) => (
              <tr key={row.id} className="border-t border-neutral-900 align-top">
                <td className="py-2 pr-2">{row.role_name}</td>
                <td className="py-2 pr-2 font-mono text-xs text-neutral-400">
                  {row.discord_role_id}
                </td>
                <td className="py-2 pr-2">
                  <button
                    type="button"
                    onClick={() => void toggle(row)}
                    disabled={busy}
                    className={`rounded px-2 py-0.5 text-xs disabled:opacity-40 ${
                      row.enabled
                        ? 'bg-emerald-950/50 text-emerald-300'
                        : 'bg-neutral-800 text-neutral-400'
                    }`}
                  >
                    {row.enabled ? 'Включено' : 'Выключено'}
                  </button>
                </td>
                <td className="py-2 pr-2">
                  <button
                    type="button"
                    onClick={() => void remove(row)}
                    disabled={busy}
                    className="rounded border border-red-900 px-3 py-0.5 text-xs text-red-400 hover:border-red-700 disabled:opacity-40"
                  >
                    Удалить
                  </button>
                </td>
              </tr>
            ))}
            {loaded && items.length === 0 ? (
              <tr>
                <td colSpan={4} className="py-3 text-center text-xs text-neutral-500">
                  Маппингов пока нет
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={roleSelectId} className="mb-1 block text-xs text-neutral-500">
            Роль панели
          </label>
          <select
            id={roleSelectId}
            value={formRoleId}
            onChange={(e) => setFormRoleId(e.target.value)}
            className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm focus:border-neutral-600 focus:outline-none"
          >
            <option value="">— выберите роль —</option>
            {assignableRoles.map((role) => (
              <option key={role.id} value={role.id}>
                {role.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={discordRoleInputId} className="mb-1 block text-xs text-neutral-500">
            ID роли Discord
          </label>
          <input
            id={discordRoleInputId}
            value={formDiscordRoleId}
            onChange={(e) => setFormDiscordRoleId(e.target.value)}
            placeholder="700000000000000001"
            className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 font-mono text-xs focus:border-neutral-600 focus:outline-none"
          />
        </div>
      </div>

      <button
        type="button"
        onClick={() => void create()}
        disabled={busy || formRoleId === '' || formDiscordRoleId.trim() === ''}
        className="rounded border border-emerald-900 px-4 py-1.5 text-sm text-emerald-300 hover:border-emerald-700 disabled:opacity-40"
      >
        Добавить
      </button>
    </section>
  );
}
