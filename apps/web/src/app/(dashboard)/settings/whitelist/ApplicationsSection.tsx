'use client';

import { useCallback, useEffect, useState } from 'react';

interface ApplicationSettings {
  enabled: boolean;
  default_days: number | null;
}

interface ApplicationItem {
  id: string;
  steam_id64: string;
  player_id: string | null;
  player_name: string | null;
  contact: string | null;
  body: string;
  requested_role_id: string | null;
  requested_role_name: string | null;
  status: string;
  reviewer_name: string | null;
  review_note: string | null;
  granted_role_name: string | null;
  granted_until: string | null;
  source: string;
  created_at: string;
  decided_at: string | null;
}

interface RoleOption {
  id: string;
  name: string;
  is_system_role: boolean;
}

type StatusFilter = 'pending' | 'approved' | 'rejected';

/** Approval term presets → an `expires_at` resolver. `default` omits the field
 * so the API applies the portal's `default_days`; `permanent` sends an explicit
 * null (never expires). */
const TERM_PRESETS: { value: string; label: string; days: number | null | 'default' }[] = [
  { value: 'default', label: 'По умолчанию', days: 'default' },
  { value: '30', label: '30 дней', days: 30 },
  { value: '90', label: '90 дней', days: 90 },
  { value: '180', label: '180 дней', days: 180 },
  { value: '365', label: '365 дней', days: 365 },
  { value: 'permanent', label: 'Бессрочно', days: null },
];

const DAY_MS = 24 * 60 * 60 * 1000;

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * «Заявки на whitelist» (WL-3, #67) — секция на `/settings/whitelist`.
 * Мастер-свитч публичного портала + срок по умолчанию, и очередь заявок с
 * одобрением (роль + срок → time-bounded grant, авто-снятие через
 * `worker-role-expirer`) или отклонением. Управление доступно только с правом
 * `whitelist:edit`; просмотр — с `whitelist:view`.
 */
export function ApplicationsSection({ canEdit }: { canEdit: boolean }) {
  const [settings, setSettings] = useState<ApplicationSettings | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [defaultDays, setDefaultDays] = useState('');
  const [items, setItems] = useState<ApplicationItem[]>([]);
  const [roleOptions, setRoleOptions] = useState<RoleOption[]>([]);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('pending');
  const [savingSettings, setSavingSettings] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Per-row approve inputs.
  const [rolePick, setRolePick] = useState<Record<string, string>>({});
  const [termPick, setTermPick] = useState<Record<string, string>>({});
  const [notePick, setNotePick] = useState<Record<string, string>>({});

  const loadList = useCallback(async (status: StatusFilter) => {
    const res = await fetch(`/api/v1/whitelist/applications?status=${status}`, {
      credentials: 'include',
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { items: ApplicationItem[] };
    setItems(body.items);
  }, []);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [settingsRes, rolesRes] = await Promise.all([
        fetch('/api/v1/whitelist/applications/settings', {
          credentials: 'include',
          cache: 'no-store',
        }),
        fetch('/api/v1/roles', { credentials: 'include', cache: 'no-store' }),
      ]);
      if (settingsRes.ok) {
        const loaded = (await settingsRes.json()) as ApplicationSettings;
        setSettings(loaded);
        setEnabled(loaded.enabled);
        setDefaultDays(loaded.default_days == null ? '' : String(loaded.default_days));
      } else {
        throw new Error(`HTTP ${settingsRes.status}`);
      }
      if (rolesRes.ok) setRoleOptions((await rolesRes.json()) as RoleOption[]);
      await loadList(statusFilter);
    } catch (e) {
      setError(`Не удалось загрузить заявки: ${(e as Error).message}`);
    }
  }, [loadList, statusFilter]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function saveSettings() {
    if (!canEdit) return;
    const parsedDays = defaultDays.trim() === '' ? null : Number.parseInt(defaultDays, 10);
    if (parsedDays != null && (Number.isNaN(parsedDays) || parsedDays < 1)) {
      setError('Срок по умолчанию должен быть положительным числом дней или пустым.');
      return;
    }
    setSavingSettings(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch('/api/v1/whitelist/applications/settings', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled, default_days: parsedDays }),
      });
      if (!res.ok) {
        const e = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        setError(`Ошибка сохранения: ${e.error ?? res.status}`);
        return;
      }
      const fresh = (await res.json()) as ApplicationSettings;
      setSettings(fresh);
      setNotice('Настройки портала сохранены.');
    } catch (e) {
      setError(`Ошибка сети: ${(e as Error).message}`);
    } finally {
      setSavingSettings(false);
    }
  }

  function resolveExpiresAt(id: string): string | null | undefined {
    const preset = TERM_PRESETS.find((p) => p.value === (termPick[id] ?? 'default'));
    if (!preset || preset.days === 'default') return undefined;
    if (preset.days === null) return null;
    return new Date(Date.now() + preset.days * DAY_MS).toISOString();
  }

  async function decide(id: string, status: 'approved' | 'rejected') {
    if (!canEdit) return;
    setBusyId(id);
    setError(null);
    setNotice(null);
    try {
      const payload: Record<string, unknown> = { status };
      if (status === 'approved') {
        // The role select defaults to the requested role; mirror that displayed
        // choice into the payload (an explicit blank pick sends nothing, letting
        // the API fall back to the configured whitelist role).
        const requestedRoleId = items.find((a) => a.id === id)?.requested_role_id ?? '';
        const roleId = rolePick[id] ?? requestedRoleId;
        if (roleId) payload.role_id = roleId;
        const expiresAt = resolveExpiresAt(id);
        if (expiresAt !== undefined) payload.expires_at = expiresAt;
      }
      const note = notePick[id]?.trim();
      if (note) payload.review_note = note;

      const res = await fetch(`/api/v1/whitelist/applications/${id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const e = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        setError(`Не удалось обработать заявку: ${e.error ?? res.status}`);
        return;
      }
      setNotice(status === 'approved' ? 'Заявка одобрена.' : 'Заявка отклонена.');
      await loadList(statusFilter);
    } catch (e) {
      setError(`Ошибка сети: ${(e as Error).message}`);
    } finally {
      setBusyId(null);
    }
  }

  const assignableRoles = roleOptions.filter((r) => !(r.is_system_role && r.name === 'Owner'));

  return (
    <section className="rounded-lg border border-neutral-800 bg-neutral-950 p-5 space-y-4">
      <h2 className="text-sm font-semibold uppercase tracking-widest text-neutral-500">
        Заявки на whitelist
      </h2>
      <p className="text-xs text-neutral-500">
        Публичный портал <code>/public/whitelist</code>: любой игрок оставляет заявку, а вы
        одобряете её с ролью и сроком (по истечении срок снимается автоматически) или отклоняете.
      </p>

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

      <div className="flex flex-wrap items-end gap-4 border-b border-neutral-900 pb-4">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={enabled}
            disabled={!canEdit}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          <span>Приём заявок открыт</span>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-neutral-400">
            Срок по умолчанию (дней, пусто = бессрочно)
          </span>
          <input
            type="number"
            min={1}
            value={defaultDays}
            disabled={!canEdit}
            onChange={(e) => setDefaultDays(e.target.value)}
            placeholder="бессрочно"
            className="w-40 rounded border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-sm disabled:opacity-60"
          />
        </label>
        {canEdit ? (
          <button
            type="button"
            onClick={saveSettings}
            disabled={
              savingSettings ||
              (settings != null &&
                enabled === settings.enabled &&
                (defaultDays.trim() === '' ? null : Number.parseInt(defaultDays, 10)) ===
                  settings.default_days)
            }
            className="rounded-md border border-sky-700 bg-sky-950 px-3 py-1.5 text-sm text-sky-200 hover:bg-sky-900 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {savingSettings ? 'Сохраняем…' : 'Сохранить настройки портала'}
          </button>
        ) : null}
      </div>

      <div className="flex items-center gap-2 text-sm">
        <span className="text-neutral-400">Статус:</span>
        {(['pending', 'approved', 'rejected'] as StatusFilter[]).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStatusFilter(s)}
            className={`rounded border px-2 py-1 text-xs ${
              statusFilter === s
                ? 'border-sky-700 bg-sky-950 text-sky-200'
                : 'border-neutral-800 text-neutral-400 hover:border-neutral-600'
            }`}
          >
            {s === 'pending' ? 'На рассмотрении' : s === 'approved' ? 'Одобренные' : 'Отклонённые'}
          </button>
        ))}
      </div>

      {items.length === 0 ? (
        <p className="py-4 text-center text-sm text-neutral-500">Заявок нет.</p>
      ) : (
        <ul className="space-y-3">
          {items.map((app) => (
            <li
              key={app.id}
              className="rounded border border-neutral-800 bg-neutral-900/40 p-4 space-y-2"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-mono text-sm text-neutral-200">{app.steam_id64}</span>
                <span className="text-xs text-neutral-500">{formatDate(app.created_at)}</span>
              </div>
              <div className="text-xs text-neutral-400">
                {app.player_name ? `Игрок: ${app.player_name}` : 'Игрок не найден в базе'}
                {app.requested_role_name ? ` · запрошена роль: ${app.requested_role_name}` : ''}
                {app.contact ? ` · контакт: ${app.contact}` : ''}
              </div>
              <p className="whitespace-pre-wrap text-sm text-neutral-200">{app.body}</p>

              {app.status !== 'pending' ? (
                <div className="text-xs text-neutral-500">
                  {app.status === 'approved'
                    ? `Одобрено${app.granted_role_name ? ` (${app.granted_role_name})` : ''}, до ${formatDate(app.granted_until)}`
                    : 'Отклонено'}
                  {app.reviewer_name ? ` · ${app.reviewer_name}` : ''}
                  {app.review_note ? ` · «${app.review_note}»` : ''}
                </div>
              ) : null}

              {canEdit && app.status === 'pending' ? (
                <div className="flex flex-wrap items-end gap-2 border-t border-neutral-900 pt-3">
                  <label className="text-xs">
                    <span className="mb-1 block text-neutral-500">Роль</span>
                    <select
                      value={rolePick[app.id] ?? app.requested_role_id ?? ''}
                      onChange={(e) => setRolePick((m) => ({ ...m, [app.id]: e.target.value }))}
                      className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs"
                    >
                      <option value="">— роль whitelist —</option>
                      {assignableRoles.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-xs">
                    <span className="mb-1 block text-neutral-500">Срок</span>
                    <select
                      value={termPick[app.id] ?? 'default'}
                      onChange={(e) => setTermPick((m) => ({ ...m, [app.id]: e.target.value }))}
                      className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs"
                    >
                      {TERM_PRESETS.map((p) => (
                        <option key={p.value} value={p.value}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <input
                    type="text"
                    value={notePick[app.id] ?? ''}
                    onChange={(e) => setNotePick((m) => ({ ...m, [app.id]: e.target.value }))}
                    placeholder="Комментарий (необязательно)"
                    className="min-w-40 flex-1 rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs"
                  />
                  <button
                    type="button"
                    onClick={() => decide(app.id, 'approved')}
                    disabled={busyId === app.id}
                    className="rounded-md border border-emerald-700 bg-emerald-950 px-3 py-1 text-xs text-emerald-200 hover:bg-emerald-900 disabled:opacity-60"
                  >
                    Одобрить
                  </button>
                  <button
                    type="button"
                    onClick={() => decide(app.id, 'rejected')}
                    disabled={busyId === app.id}
                    className="rounded-md border border-red-800 bg-red-950 px-3 py-1 text-xs text-red-200 hover:bg-red-900 disabled:opacity-60"
                  >
                    Отклонить
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
