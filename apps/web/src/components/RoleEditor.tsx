'use client';
import { ROLE_COLORS, type RoleColor } from '@squad/shared-config/role-colors';
import { useEffect, useMemo, useState } from 'react';
import { RoleColorDot } from './RoleColorDot';

interface PermissionDef {
  key: string;
  category: string;
  label: string;
  dangerous?: true;
  unimplemented?: true;
}

interface RoleEditorProps {
  initial?: {
    name: string;
    color: RoleColor;
    description: string | null;
    permissions: string[];
    isSystemRole?: boolean;
    isOwner?: boolean;
  };
  onSubmit: (data: {
    name: string;
    color: RoleColor;
    description: string | null;
    permissions: string[];
  }) => Promise<void>;
  onCancel: () => void;
  submitLabel: string;
}

const CATEGORY_ORDER: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'servers', label: 'Серверы' },
  { id: 'configs', label: 'Конфиги' },
  { id: 'players', label: 'Игроки' },
  { id: 'moderation', label: 'Модерация' },
  { id: 'admin_groups', label: 'Squad-группы' },
  { id: 'whitelist', label: 'Whitelist' },
  { id: 'host', label: 'Хост' },
  { id: 'audit', label: 'Журнал' },
  { id: 'events', label: 'События' },
  { id: 'users', label: 'Пользователи' },
  { id: 'roles', label: 'Роли' },
  { id: 'backup', label: 'Backup' },
  { id: 'api_tokens', label: 'API-токены' },
  { id: 'discord', label: 'Discord' },
  { id: 'triggers', label: 'Триггеры' },
  { id: 'scheduler', label: 'Расписание' },
];

export function RoleEditor({ initial, onSubmit, onCancel, submitLabel }: RoleEditorProps) {
  const [name, setName] = useState(initial?.name ?? '');
  const [color, setColor] = useState<RoleColor>(initial?.color ?? 'neutral');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [permissions, setPermissions] = useState<Set<string>>(new Set(initial?.permissions ?? []));
  const [registry, setRegistry] = useState<PermissionDef[] | null>(null);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const readOnly = initial?.isOwner === true;

  useEffect(() => {
    fetch('/api/v1/permissions', { credentials: 'include' })
      .then((r) => r.json())
      .then(setRegistry)
      .catch(() => setErr('Не удалось загрузить список permissions'));
  }, []);

  const filtered = useMemo(() => {
    if (!registry) return null;
    const q = search.toLowerCase().trim();
    if (!q) return registry;
    return registry.filter(
      (p) => p.key.toLowerCase().includes(q) || p.label.toLowerCase().includes(q),
    );
  }, [registry, search]);

  const grouped = useMemo(() => {
    if (!filtered) return null;
    const map = new Map<string, PermissionDef[]>();
    for (const p of filtered) {
      const arr = map.get(p.category) ?? [];
      arr.push(p);
      map.set(p.category, arr);
    }
    return map;
  }, [filtered]);

  function toggle(key: string) {
    if (readOnly) return;
    setPermissions((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function submit() {
    if (readOnly) return;
    if (!name.trim()) {
      setErr('Имя обязательно');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await onSubmit({
        name: name.trim(),
        color,
        description: description.trim() || null,
        permissions: [...permissions],
      });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      {readOnly ? (
        <div className="rounded border border-amber-700/60 bg-amber-950/40 p-3 text-sm text-amber-200">
          Системная роль <strong>Owner</strong>. Permissions, имя и цвет не редактируются.
        </div>
      ) : null}
      {err ? (
        <div className="rounded border border-red-900 bg-red-950 p-3 text-sm text-red-200">
          {err}
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <label className="block">
          <span className="text-xs uppercase tracking-widest text-neutral-400">Имя</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={readOnly}
            className="mt-1 w-full rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm disabled:opacity-50"
          />
        </label>
        <div>
          <span className="text-xs uppercase tracking-widest text-neutral-400">Цвет</span>
          <div className="mt-1 flex flex-wrap gap-2">
            {ROLE_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                disabled={readOnly}
                onClick={() => setColor(c)}
                className={`flex items-center gap-1 rounded border px-2 py-1 text-xs ${
                  color === c
                    ? 'border-sky-400 bg-sky-950/40'
                    : 'border-neutral-800 hover:border-neutral-600'
                } disabled:opacity-50`}
              >
                <RoleColorDot color={c} size="sm" />
                <span className="font-mono">{c}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      <label className="block">
        <span className="text-xs uppercase tracking-widest text-neutral-400">Описание</span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          disabled={readOnly}
          rows={2}
          className="mt-1 w-full rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm disabled:opacity-50"
        />
      </label>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs uppercase tracking-widest text-neutral-400">Permissions</span>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="поиск..."
            className="w-48 rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-xs"
          />
        </div>
        {!grouped ? (
          <div className="text-sm text-neutral-500">Загрузка…</div>
        ) : (
          <div className="grid grid-cols-1 gap-x-6 gap-y-4 md:grid-cols-2 xl:grid-cols-3">
            {CATEGORY_ORDER.filter((c) => grouped.has(c.id)).map((cat) => (
              <div key={cat.id}>
                <h4 className="mb-1 text-xs font-semibold uppercase tracking-widest text-neutral-300">
                  {cat.label}
                </h4>
                <ul className="space-y-1">
                  {(grouped.get(cat.id) ?? []).map((p) => {
                    const checked = permissions.has(p.key);
                    return (
                      <li key={p.key}>
                        <label
                          className={`flex items-start gap-2 text-sm ${
                            p.unimplemented ? 'opacity-50' : ''
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={readOnly}
                            onChange={() => toggle(p.key)}
                            className="mt-0.5"
                          />
                          <span>
                            {p.label}
                            {p.dangerous ? <span className="ml-1 text-amber-400">⚠️</span> : null}
                            {p.unimplemented ? (
                              <span className="ml-1 text-xs text-neutral-500">(в разработке)</span>
                            ) : null}
                            <span className="ml-2 font-mono text-xs text-neutral-600">{p.key}</span>
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>

      {!readOnly ? (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={submit}
            disabled={busy}
            className="rounded bg-sky-600 px-4 py-2 text-sm text-white hover:bg-sky-500 disabled:opacity-40"
          >
            {submitLabel}
          </button>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded border border-neutral-800 px-4 py-2 text-sm hover:border-neutral-600"
          >
            Отмена
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-neutral-800 px-4 py-2 text-sm hover:border-neutral-600"
        >
          Назад
        </button>
      )}
    </div>
  );
}
