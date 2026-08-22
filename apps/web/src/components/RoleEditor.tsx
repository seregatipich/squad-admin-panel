'use client';
import { ROLE_COLORS, type RoleColor } from '@squad/shared-config/role-colors';
import { useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardGrid,
  CardHeader,
  Checkbox,
  FieldRow,
  InlineBanner,
  SearchField,
  Skeleton,
  Textarea,
  TextInput,
} from '@/components/ui';
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

/**
 * Russian labels for every `PERMISSION_CATEGORIES` member, in display order.
 *
 * This is a hand-maintained mirror of the closed tuple in
 * `@squad/shared-config`: a permission key whose category is missing here
 * silently disappears from the role editor. `RoleEditor.test.ts` asserts the
 * two stay in lockstep — add the category here in the same change that adds it
 * to the catalog.
 */
export const CATEGORY_ORDER: ReadonlyArray<{ id: string; label: string }> = [
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
  { id: 'balancer', label: 'Балансировщик' },
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
      .catch(() => setErr('Не удалось загрузить список прав'));
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
        <InlineBanner
          tone="warn"
          title="Системная роль Owner"
          description="Права, имя и цвет этой роли не редактируются."
        />
      ) : null}
      {err ? <InlineBanner tone="crit" title="Ошибка" description={err} /> : null}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <FieldRow label="Имя">
          <TextInput
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={readOnly}
            required
          />
        </FieldRow>
        {/* Цвет роли различает соседние роли в списках и ничего не сообщает
            сам по себе, поэтому у каждой кнопки написано имя оттенка, а
            выбранная объявляется `aria-pressed`, а не только рамкой (§5). */}
        <fieldset className="flex flex-col gap-1">
          <legend className="text-xs font-medium text-ink-2">Цвет</legend>
          <div className="flex flex-wrap gap-2">
            {ROLE_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                disabled={readOnly}
                aria-pressed={color === c}
                onClick={() => setColor(c)}
                className={`inline-flex h-7 items-center gap-1.5 rounded-ctl border px-2.5 text-2xs transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40 ${
                  color === c
                    ? 'border-accent bg-accent-dim text-ink'
                    : 'border-line bg-raised text-ink-2 hover:text-ink'
                }`}
              >
                <RoleColorDot color={c} size="sm" />
                <span className="font-mono">{c}</span>
              </button>
            ))}
          </div>
        </fieldset>
      </div>

      <FieldRow label="Описание">
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          disabled={readOnly}
          rows={2}
        />
      </FieldRow>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-[17px] font-semibold text-ink">Права</h3>
          <div className="w-48">
            <SearchField
              value={search}
              onCommit={setSearch}
              label="Поиск по правам"
              placeholder="право или ключ"
              clearLabel="Очистить поиск"
            />
          </div>
        </div>

        {!grouped ? (
          <Skeleton variant="card" count={3} label="Загрузка списка прав" />
        ) : (
          <CardGrid cols={3}>
            {CATEGORY_ORDER.filter((c) => grouped.has(c.id)).map((cat) => (
              <Card key={cat.id} padding="none">
                <CardHeader title={cat.label} headingLevel={3} />
                <CardBody padding="sm">
                  <ul className="space-y-1">
                    {(grouped.get(cat.id) ?? []).map((p) => (
                      <li key={p.key}>
                        <Checkbox
                          checked={permissions.has(p.key)}
                          disabled={readOnly}
                          onChange={() => toggle(p.key)}
                          className={p.unimplemented ? 'opacity-60' : undefined}
                          label={
                            <span className="inline-flex flex-wrap items-center gap-1.5">
                              <span>{p.label}</span>
                              {p.dangerous ? (
                                <Badge tone="warn" size="sm">
                                  опасное
                                </Badge>
                              ) : null}
                              {p.unimplemented ? (
                                <span className="text-2xs text-ink-3">(в разработке)</span>
                              ) : null}
                              <span className="font-mono text-2xs text-ink-3">{p.key}</span>
                            </span>
                          }
                        />
                      </li>
                    ))}
                  </ul>
                </CardBody>
              </Card>
            ))}
          </CardGrid>
        )}
      </section>

      {readOnly ? (
        <Button onClick={onCancel}>Назад</Button>
      ) : (
        <div className="flex justify-end gap-2">
          <Button onClick={onCancel} disabled={busy}>
            Отмена
          </Button>
          <Button variant="primary" onClick={submit} loading={busy}>
            {submitLabel}
          </Button>
        </div>
      )}
    </div>
  );
}
