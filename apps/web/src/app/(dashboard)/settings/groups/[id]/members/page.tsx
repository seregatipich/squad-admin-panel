'use client';

import type { RoleColor } from '@squad/shared-config/role-colors';
import Link from 'next/link';
import { use, useCallback, useEffect, useState } from 'react';
import { RoleColorDot } from '@/components/RoleColorDot';

interface Member {
  id: string;
  steam_id64: string | null;
  canonical_name: string;
  last_seen_at: string;
  role_comment: string | null;
}

interface MembersResponse {
  role: { id: string; name: string; color: string };
  items: Member[];
  total: number;
  limit: number;
  offset: number;
}

interface PlayerSearchItem {
  id: string;
  steam_id64: string | null;
  canonical_name: string;
  last_seen_at: string;
}

interface RoleOption {
  id: string;
  name: string;
  color: string;
  is_system_role: boolean;
}

interface ImportRowError {
  line: number;
  steam_id64: string;
  reason: string;
}

interface Me {
  permissions: string[];
}

const PAGE_SIZE = 100;

const IMPORT_REASON_LABELS: Record<string, string> = {
  invalid_steam_id64: 'некорректный SteamID64',
  duplicate_steam_id64: 'дубликат SteamID64 в файле',
  comment_too_long: 'комментарий слишком длинный',
  player_not_found: 'игрок не найден в базе',
  owner_reassignment_forbidden: 'нельзя переназначить владельца',
};

export default function RoleMembersPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [data, setData] = useState<MembersResponse | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [roles, setRoles] = useState<RoleOption[]>([]);
  const [q, setQ] = useState('');
  const [offset, setOffset] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    const url = new URL(`/api/v1/roles/${id}/members`, window.location.origin);
    url.searchParams.set('limit', String(PAGE_SIZE));
    url.searchParams.set('offset', String(offset));
    if (q.trim()) url.searchParams.set('q', q.trim());
    const r = await fetch(url.toString().replace(window.location.origin, ''), {
      credentials: 'include',
      cache: 'no-store',
    });
    if (!r.ok) {
      setErr(`HTTP ${r.status}`);
      return;
    }
    setSelected(new Set());
    setData((await r.json()) as MembersResponse);
  }, [id, offset, q]);

  useEffect(() => {
    void load();
    fetch('/api/v1/me', { credentials: 'include', cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => setMe(j as Me | null))
      .catch(() => {});
    fetch('/api/v1/roles', { credentials: 'include', cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : []))
      .then((j) => setRoles(j as RoleOption[]))
      .catch(() => {});
  }, [load]);

  const canManage = me?.permissions.includes('user:manage_roles') ?? false;

  function toggleOne(playerId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(playerId)) next.delete(playerId);
      else next.add(playerId);
      return next;
    });
  }

  function toggleAll(items: Member[]) {
    setSelected((prev) => {
      const allSelected = items.length > 0 && items.every((m) => prev.has(m.id));
      return allSelected ? new Set() : new Set(items.map((m) => m.id));
    });
  }

  async function removeMember(playerId: string, name: string) {
    if (!canManage) return;
    if (!confirm(`Снять роль с игрока «${name}»?`)) return;
    setErr(null);
    const r = await fetch(`/api/v1/roles/${id}/members/${playerId}`, {
      method: 'DELETE',
      credentials: 'include',
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}) as Record<string, unknown>);
      setErr(`Ошибка: ${e.error ?? r.status}`);
      return;
    }
    await load();
  }

  async function addMember(playerId: string) {
    setErr(null);
    const r = await fetch(`/api/v1/roles/${id}/members`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ player_id: playerId }),
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}) as Record<string, unknown>);
      setErr(`Ошибка: ${e.error ?? r.status}`);
      return;
    }
    setAddOpen(false);
    await load();
  }

  async function bulkDelete() {
    if (!canManage || selected.size === 0) return;
    if (!confirm(`Снять роль с выбранных игроков (${selected.size})?`)) return;
    setErr(null);
    const r = await fetch(`/api/v1/roles/${id}/members/bulk-delete`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ player_ids: [...selected] }),
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}) as Record<string, unknown>);
      setErr(`Ошибка: ${e.error ?? r.status}`);
      return;
    }
    await load();
  }

  async function exportCsv() {
    setErr(null);
    const r = await fetch(`/api/v1/roles/${id}/members/export`, { credentials: 'include' });
    if (!r.ok) {
      setErr(`Ошибка экспорта: ${r.status}`);
      return;
    }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `role-${data?.role.name ?? id}-members.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  if (err) {
    return (
      <div className="space-y-3">
        <Link href="/settings/groups" className="text-sky-400 text-xs">
          ← Назад к списку ролей
        </Link>
        <div className="rounded border border-red-900 bg-red-950 p-3 text-sm text-red-200">
          {err}
        </div>
      </div>
    );
  }
  if (!data) return <div className="text-neutral-500">Загрузка…</div>;

  const totalPages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;
  const allOnPageSelected = data.items.length > 0 && data.items.every((m) => selected.has(m.id));

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/settings/groups" className="text-sky-400 text-xs">
            ← Назад к списку ролей
          </Link>
          <RoleColorDot color={data.role.color as RoleColor | string} />
          <h1 className="text-2xl font-semibold">{data.role.name}</h1>
          <span className="text-sm text-neutral-500">— {data.total} участников</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={exportCsv}
            className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-800"
          >
            Экспорт CSV
          </button>
          {canManage ? (
            <>
              <button
                type="button"
                onClick={() => setImportOpen(true)}
                className="rounded-md border border-emerald-700 bg-emerald-950 px-3 py-1.5 text-sm text-emerald-200 hover:bg-emerald-900"
              >
                Импорт CSV
              </button>
              <button
                type="button"
                onClick={() => setAddOpen(true)}
                className="rounded-md border border-sky-700 bg-sky-950 px-3 py-1.5 text-sm text-sky-200 hover:bg-sky-900"
              >
                + Добавить игрока
              </button>
            </>
          ) : null}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <input
          type="text"
          placeholder="Поиск по нику или SteamID64…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOffset(0);
          }}
          className="w-80 rounded border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-sm"
        />
      </div>

      {canManage && selected.size > 0 ? (
        <div
          data-testid="bulk-toolbar"
          className="flex items-center gap-2 rounded border border-neutral-800 bg-neutral-900/60 px-3 py-2 text-sm"
        >
          <span className="text-neutral-300">Выбрано: {selected.size}</span>
          <button
            type="button"
            onClick={bulkDelete}
            className="rounded border border-red-900 px-2 py-0.5 text-xs text-red-300 hover:bg-red-950"
          >
            Удалить выбранных
          </button>
          <button
            type="button"
            onClick={() => setMoveOpen(true)}
            className="rounded border border-amber-800 px-2 py-0.5 text-xs text-amber-200 hover:bg-amber-950"
          >
            Переместить в роль
          </button>
        </div>
      ) : null}

      <table className="w-full table-fixed border-collapse text-sm">
        <thead className="text-left text-xs uppercase tracking-widest text-neutral-500">
          <tr>
            {canManage ? (
              <th className="w-8 border-b border-neutral-800 px-2 py-2">
                <input
                  type="checkbox"
                  aria-label="Выбрать всех на странице"
                  checked={allOnPageSelected}
                  onChange={() => toggleAll(data.items)}
                />
              </th>
            ) : null}
            <th className="border-b border-neutral-800 px-2 py-2">Никнейм</th>
            <th className="w-44 border-b border-neutral-800 px-2 py-2">SteamID64</th>
            <th className="w-52 border-b border-neutral-800 px-2 py-2">Комментарий</th>
            <th className="w-44 border-b border-neutral-800 px-2 py-2">Last seen</th>
            <th className="w-28 border-b border-neutral-800 px-2 py-2 text-right">Действие</th>
          </tr>
        </thead>
        <tbody>
          {data.items.length === 0 ? (
            <tr>
              <td colSpan={canManage ? 6 : 5} className="px-2 py-3 text-neutral-500">
                Нет участников
              </td>
            </tr>
          ) : null}
          {data.items.map((m) => (
            <tr key={m.id} className="border-b border-neutral-900 hover:bg-neutral-900/40">
              {canManage ? (
                <td className="px-2 py-2">
                  <input
                    type="checkbox"
                    aria-label={`Выбрать ${m.canonical_name}`}
                    checked={selected.has(m.id)}
                    onChange={() => toggleOne(m.id)}
                  />
                </td>
              ) : null}
              <td className="px-2 py-2">
                <Link href={`/players/${m.id}`} className="text-sky-400 hover:text-sky-300">
                  {m.canonical_name}
                </Link>
              </td>
              <td className="px-2 py-2 font-mono text-xs">{m.steam_id64 ?? '—'}</td>
              <td className="px-2 py-2 text-xs text-neutral-400">{m.role_comment ?? '—'}</td>
              <td className="px-2 py-2 text-xs text-neutral-400">
                {new Date(m.last_seen_at).toLocaleString('ru-RU')}
              </td>
              <td className="px-2 py-2 text-right">
                {canManage ? (
                  <button
                    type="button"
                    onClick={() => removeMember(m.id, m.canonical_name)}
                    className="rounded border border-red-900 px-2 py-0.5 text-xs text-red-300 hover:bg-red-950"
                  >
                    Снять
                  </button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="flex items-center justify-between">
        <div className="text-xs text-neutral-500">
          Страница {currentPage} / {totalPages}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            className="rounded border border-neutral-800 px-2 py-0.5 text-xs disabled:opacity-40"
          >
            ← пред.
          </button>
          <button
            type="button"
            disabled={offset + PAGE_SIZE >= data.total}
            onClick={() => setOffset(offset + PAGE_SIZE)}
            className="rounded border border-neutral-800 px-2 py-0.5 text-xs disabled:opacity-40"
          >
            след. →
          </button>
        </div>
      </div>

      {addOpen ? (
        <AddMemberModal onClose={() => setAddOpen(false)} onAdd={(p) => addMember(p.id)} />
      ) : null}

      {importOpen ? (
        <ImportModal
          roleId={id}
          onClose={() => setImportOpen(false)}
          onImported={() => {
            setImportOpen(false);
            void load();
          }}
        />
      ) : null}

      {moveOpen ? (
        <MoveModal
          roleId={id}
          count={selected.size}
          roles={roles.filter((r) => r.id !== id && !(r.is_system_role && r.name === 'Owner'))}
          onClose={() => setMoveOpen(false)}
          onMove={async (targetRoleId) => {
            setErr(null);
            const r = await fetch(`/api/v1/roles/${id}/members/move`, {
              method: 'POST',
              credentials: 'include',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ player_ids: [...selected], target_role_id: targetRoleId }),
            });
            if (!r.ok) {
              const e = await r.json().catch(() => ({}) as Record<string, unknown>);
              setErr(`Ошибка перемещения: ${e.error ?? r.status}`);
              return;
            }
            setMoveOpen(false);
            await load();
          }}
        />
      ) : null}
    </div>
  );
}

function ImportModal({
  roleId,
  onClose,
  onImported,
}: {
  roleId: string;
  onClose: () => void;
  onImported: () => void;
}) {
  const [csv, setCsv] = useState('');
  const [errors, setErrors] = useState<ImportRowError[]>([]);
  const [topError, setTopError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (csv.trim().length === 0) return;
    setBusy(true);
    setErrors([]);
    setTopError(null);
    const r = await fetch(`/api/v1/roles/${roleId}/members/import`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ csv }),
    });
    setBusy(false);
    if (r.status === 201) {
      onImported();
      return;
    }
    const body = (await r.json().catch(() => ({}))) as {
      error?: string;
      errors?: ImportRowError[];
    };
    if (r.status === 422 && Array.isArray(body.errors)) {
      setErrors(body.errors);
      return;
    }
    setTopError(body.error ?? `HTTP ${r.status}`);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
      <div
        data-testid="import-modal"
        className="w-full max-w-lg rounded-lg border border-neutral-800 bg-neutral-950 p-5"
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-lg font-semibold">Импорт из CSV</h3>
          <button
            type="button"
            onClick={onClose}
            className="text-xs text-neutral-400 hover:text-neutral-200"
          >
            закрыть
          </button>
        </div>
        <p className="mb-2 text-xs text-neutral-500">
          Одна строка на игрока: <code>SteamID64</code>, необязательный комментарий после{' '}
          <code>;</code>. Если хотя бы одна строка некорректна, не импортируется ничего.
        </p>
        <textarea
          data-testid="import-textarea"
          value={csv}
          onChange={(e) => setCsv(e.target.value)}
          placeholder={'76561198000000000;основной состав\n76561198000000001'}
          rows={8}
          className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 font-mono text-xs"
        />
        {topError ? (
          <div className="mt-2 rounded border border-red-900 bg-red-950 p-2 text-xs text-red-200">
            Ошибка: {topError}
          </div>
        ) : null}
        {errors.length > 0 ? (
          <div
            data-testid="import-errors"
            className="mt-2 rounded border border-red-900 bg-red-950 p-2 text-xs text-red-200"
          >
            <div className="mb-1 font-semibold">
              Файл отклонён — исправьте {errors.length} строк(и) и повторите:
            </div>
            <ul className="space-y-0.5">
              {errors.map((e) => (
                <li key={`${e.line}-${e.steam_id64}`}>
                  Строка {e.line} («{e.steam_id64}»): {IMPORT_REASON_LABELS[e.reason] ?? e.reason}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-neutral-800 px-3 py-1.5 text-sm text-neutral-300"
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy || csv.trim().length === 0}
            className="rounded border border-emerald-700 bg-emerald-950 px-3 py-1.5 text-sm text-emerald-200 hover:bg-emerald-900 disabled:opacity-40"
          >
            Импортировать
          </button>
        </div>
      </div>
    </div>
  );
}

function MoveModal({
  count,
  roles,
  onClose,
  onMove,
}: {
  roleId: string;
  count: number;
  roles: RoleOption[];
  onClose: () => void;
  onMove: (targetRoleId: string) => void | Promise<void>;
}) {
  const [target, setTarget] = useState('');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
      <div
        data-testid="move-modal"
        className="w-full max-w-md rounded-lg border border-neutral-800 bg-neutral-950 p-5"
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-lg font-semibold">Переместить в роль ({count})</h3>
          <button
            type="button"
            onClick={onClose}
            className="text-xs text-neutral-400 hover:text-neutral-200"
          >
            закрыть
          </button>
        </div>
        <select
          aria-label="Целевая роль"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-sm"
        >
          <option value="">— выберите роль —</option>
          {roles.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-neutral-800 px-3 py-1.5 text-sm text-neutral-300"
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={() => target && onMove(target)}
            disabled={target === ''}
            className="rounded border border-amber-800 bg-amber-950 px-3 py-1.5 text-sm text-amber-200 hover:bg-amber-900 disabled:opacity-40"
          >
            Переместить
          </button>
        </div>
      </div>
    </div>
  );
}

function AddMemberModal({
  onClose,
  onAdd,
}: {
  onClose: () => void;
  onAdd: (p: PlayerSearchItem) => void;
}) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<PlayerSearchItem[]>([]);

  useEffect(() => {
    const handler = setTimeout(async () => {
      if (q.trim().length < 2) {
        setResults([]);
        return;
      }
      const url = new URL('/api/v1/players', window.location.origin);
      url.searchParams.set('q', q.trim());
      const r = await fetch(url.toString().replace(window.location.origin, ''), {
        credentials: 'include',
        cache: 'no-store',
      });
      if (r.ok) {
        const j = (await r.json()) as { items: PlayerSearchItem[] };
        setResults(j.items.slice(0, 30));
      }
    }, 250);
    return () => clearTimeout(handler);
  }, [q]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
      <div className="w-full max-w-lg rounded-lg border border-neutral-800 bg-neutral-950 p-5">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-lg font-semibold">Добавить игрока</h3>
          <button
            type="button"
            onClick={onClose}
            className="text-xs text-neutral-400 hover:text-neutral-200"
          >
            закрыть
          </button>
        </div>
        <input
          type="text"
          placeholder="Ник или SteamID64…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-sm"
        />
        <ul className="mt-3 max-h-80 divide-y divide-neutral-900 overflow-auto">
          {results.length === 0 ? (
            <li className="py-2 text-xs text-neutral-500">Введите хотя бы 2 символа для поиска…</li>
          ) : null}
          {results.map((r) => (
            <li key={r.id} className="flex items-center justify-between py-2">
              <div className="flex flex-col">
                <span className="text-sm">{r.canonical_name}</span>
                <span className="font-mono text-[11px] text-neutral-500">
                  {r.steam_id64 ?? '—'}
                </span>
              </div>
              <button
                type="button"
                onClick={() => onAdd(r)}
                className="rounded border border-sky-700 bg-sky-950 px-2 py-0.5 text-xs text-sky-200 hover:bg-sky-900"
              >
                Назначить
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
