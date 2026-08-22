'use client';

import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  FieldRow,
  InlineBanner,
  PageContainer,
  PageHeader,
  Select,
  SkeletonTable,
  Table,
  TableBody,
  TableHead,
  TableRow,
  Td,
  TextInput,
  Th,
} from '@/components/ui';
import { getLiveBus } from '@/lib/live-bus';
import {
  isSameOrder,
  isValidSlug,
  MARK_TYPE_ICONS,
  MARK_TYPE_SEVERITY_MAX,
  MARK_TYPE_SEVERITY_MIN,
  type MarkType,
  moveItem,
  severityLabel,
  sortByOrder,
} from './helpers';

interface Me {
  permissions: string[];
}

interface DraftForm {
  slug: string;
  label_en: string;
  label_ru: string;
  icon: string;
  severity: number;
}

const EMPTY_DRAFT: DraftForm = {
  slug: '',
  label_en: '',
  label_ru: '',
  icon: MARK_TYPE_ICONS[0],
  severity: 3,
};

const SEVERITY_OPTIONS = Array.from(
  { length: MARK_TYPE_SEVERITY_MAX - MARK_TYPE_SEVERITY_MIN + 1 },
  (_, index) => MARK_TYPE_SEVERITY_MIN + index,
);

export default function MarkTypesPage() {
  const [types, setTypes] = useState<MarkType[]>([]);
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [draft, setDraft] = useState<DraftForm>(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState<Omit<DraftForm, 'slug'>>({
    label_en: '',
    label_ru: '',
    icon: MARK_TYPE_ICONS[0],
    severity: 3,
  });
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const slugId = useId();
  const canEdit = useMemo(() => me?.permissions.includes('role:edit') ?? false, [me]);

  const loadTypes = useCallback(async () => {
    const res = await fetch('/api/v1/mark-types?include_inactive=true', {
      credentials: 'include',
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setTypes(sortByOrder((await res.json()) as MarkType[]));
  }, []);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [meRes, typesRes] = await Promise.all([
        fetch('/api/v1/me', { credentials: 'include', cache: 'no-store' }),
        fetch('/api/v1/mark-types?include_inactive=true', {
          credentials: 'include',
          cache: 'no-store',
        }),
      ]);
      if (!meRes.ok) throw new Error(`HTTP ${meRes.status}`);
      if (!typesRes.ok) throw new Error(`HTTP ${typesRes.status}`);
      setMe((await meRes.json()) as Me);
      setTypes(sortByOrder((await typesRes.json()) as MarkType[]));
      setMsg(null);
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    const bus = getLiveBus();
    return bus.subscribe((event) => {
      if (event.type === 'mark_type.changed') void loadTypes();
    });
  }, [loadTypes]);

  async function createType(e: React.FormEvent) {
    e.preventDefault();
    if (!isValidSlug(draft.slug)) {
      setMsg({
        kind: 'err',
        text: 'Идентификатор: 2–40 символов, только a–z, 0–9 и подчёркивание.',
      });
      return;
    }
    if (!draft.label_en.trim() || !draft.label_ru.trim()) {
      setMsg({ kind: 'err', text: 'Заполните оба названия.' });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch('/api/v1/mark-types', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          slug: draft.slug.trim(),
          label_en: draft.label_en.trim(),
          label_ru: draft.label_ru.trim(),
          icon: draft.icon,
          severity: draft.severity,
        }),
      });
      if (res.status === 409) {
        setMsg({ kind: 'err', text: 'Тип с таким идентификатором уже существует.' });
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setDraft(EMPTY_DRAFT);
      await loadTypes();
      setMsg({ kind: 'ok', text: 'Тип метки создан и уже доступен в модалке установки.' });
    } catch (err) {
      setMsg({ kind: 'err', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  function startEdit(type: MarkType) {
    setEditingId(type.id);
    setEditDraft({
      label_en: type.label_en,
      label_ru: type.label_ru,
      icon: type.icon,
      severity: type.severity,
    });
    setMsg(null);
  }

  async function saveEdit(id: number) {
    if (!editDraft.label_en.trim() || !editDraft.label_ru.trim()) {
      setMsg({ kind: 'err', text: 'Заполните оба названия.' });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/v1/mark-types/${id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          label_en: editDraft.label_en.trim(),
          label_ru: editDraft.label_ru.trim(),
          icon: editDraft.icon,
          severity: editDraft.severity,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setEditingId(null);
      await loadTypes();
      setMsg({ kind: 'ok', text: 'Тип метки обновлён.' });
    } catch (err) {
      setMsg({ kind: 'err', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(type: MarkType) {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/v1/mark-types/${type.id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ is_active: !type.is_active }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await loadTypes();
      setMsg({
        kind: 'ok',
        text: type.is_active
          ? 'Тип деактивирован: скрыт из модалки, но сохранён в истории и фильтрах.'
          : 'Тип снова активен.',
      });
    } catch (err) {
      setMsg({ kind: 'err', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function persistOrder(next: MarkType[]) {
    const previous = types;
    setTypes(next);
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch('/api/v1/mark-types/reorder', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ordered_ids: next.map((t) => t.id) }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await loadTypes();
    } catch (err) {
      setTypes(previous);
      setMsg({ kind: 'err', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  function handleDrop(targetIndex: number) {
    if (dragIndex === null || dragIndex === targetIndex) {
      setDragIndex(null);
      return;
    }
    const next = moveItem(types, dragIndex, targetIndex);
    setDragIndex(null);
    if (!isSameOrder(next, types)) void persistOrder(next);
  }

  return (
    <PageContainer width="wide">
      <PageHeader
        title="Типы меток"
        subtitle="Справочник причин для меток подозрения. Порядок задаёт очерёдность в модалке установки. Деактивированный тип исчезает из модалки, но остаётся в истории игроков и фильтрах вотчлиста."
      />

      {msg?.kind === 'ok' ? (
        <InlineBanner
          tone="good"
          title={msg.text}
          onDismiss={() => setMsg(null)}
          dismissLabel="Скрыть сообщение"
        />
      ) : null}
      {msg?.kind === 'err' ? (
        <InlineBanner
          tone="crit"
          title="Не удалось выполнить запрос"
          description={msg.text}
          action={
            <Button size="sm" onClick={() => void loadAll()}>
              Повторить
            </Button>
          }
        />
      ) : null}

      {canEdit && !loading ? (
        <Card padding="none">
          <CardHeader title="Новый тип" />
          <CardBody>
            <form onSubmit={createType} className="grid grid-cols-1 gap-3 sm:grid-cols-6">
              <FieldRow label="Идентификатор (лат.)" htmlFor={slugId} className="sm:col-span-2">
                <TextInput
                  id={slugId}
                  type="text"
                  value={draft.slug}
                  onChange={(e) => setDraft((d) => ({ ...d, slug: e.target.value }))}
                  maxLength={40}
                  placeholder="ghost_peek"
                />
              </FieldRow>
              <FieldRow label="Название (EN)" htmlFor={`${slugId}-en`} className="sm:col-span-2">
                <TextInput
                  id={`${slugId}-en`}
                  type="text"
                  value={draft.label_en}
                  onChange={(e) => setDraft((d) => ({ ...d, label_en: e.target.value }))}
                  maxLength={64}
                />
              </FieldRow>
              <FieldRow label="Название (RU)" htmlFor={`${slugId}-ru`} className="sm:col-span-2">
                <TextInput
                  id={`${slugId}-ru`}
                  type="text"
                  value={draft.label_ru}
                  onChange={(e) => setDraft((d) => ({ ...d, label_ru: e.target.value }))}
                  maxLength={64}
                />
              </FieldRow>
              <FieldRow label="Иконка" htmlFor={`${slugId}-icon`} className="sm:col-span-2">
                <Select
                  id={`${slugId}-icon`}
                  value={draft.icon}
                  onChange={(e) => setDraft((d) => ({ ...d, icon: e.target.value }))}
                >
                  {MARK_TYPE_ICONS.map((icon) => (
                    <option key={icon} value={icon}>
                      {icon}
                    </option>
                  ))}
                </Select>
              </FieldRow>
              <FieldRow label="Тяжесть" htmlFor={`${slugId}-sev`} className="sm:col-span-2">
                <Select
                  id={`${slugId}-sev`}
                  value={draft.severity}
                  onChange={(e) => setDraft((d) => ({ ...d, severity: Number(e.target.value) }))}
                >
                  {SEVERITY_OPTIONS.map((severity) => (
                    <option key={severity} value={severity}>
                      {severity} — {severityLabel(severity)}
                    </option>
                  ))}
                </Select>
              </FieldRow>
              <div className="flex items-end sm:col-span-2">
                <Button type="submit" variant="primary" loading={busy}>
                  Создать тип
                </Button>
              </div>
            </form>
          </CardBody>
        </Card>
      ) : null}

      <Card padding="none">
        <CardHeader
          title="Таксономия"
          count={types.length}
          description={
            canEdit && types.length > 0
              ? 'Перетаскивайте строки за рукоятку слева, чтобы изменить порядок.'
              : undefined
          }
        />
        {loading ? (
          <div className="p-3">
            <SkeletonTable rows={6} cols={canEdit ? 8 : 6} label="Загрузка типов меток" />
          </div>
        ) : types.length === 0 ? (
          <EmptyState
            title="Типов пока нет"
            description="Заведите первый тип метки — он сразу появится в модалке установки метки."
          />
        ) : (
          <Table ariaLabel="Типы меток">
            <TableHead>
              <tr>
                {canEdit ? (
                  <Th width="2rem">
                    <span className="sr-only">Порядок</span>
                  </Th>
                ) : null}
                <Th>Идентификатор</Th>
                <Th>EN</Th>
                <Th>RU</Th>
                <Th>Иконка</Th>
                <Th>Тяжесть</Th>
                <Th>Статус</Th>
                {canEdit ? (
                  <Th align="right">
                    <span className="sr-only">Действия</span>
                  </Th>
                ) : null}
              </tr>
            </TableHead>
            <TableBody>
              {types.map((type, index) => {
                const isEditing = editingId === type.id;
                const cells = (
                  <>
                    {canEdit ? (
                      <Td className="cursor-grab text-ink-4">
                        <span aria-hidden="true">⠿</span>
                      </Td>
                    ) : null}
                    <Td className="font-mono text-xs text-ink-2">{type.slug}</Td>
                    {isEditing ? (
                      <>
                        <Td>
                          <TextInput
                            size="sm"
                            aria-label={`Название (EN) для ${type.slug}`}
                            value={editDraft.label_en}
                            onChange={(e) =>
                              setEditDraft((d) => ({ ...d, label_en: e.target.value }))
                            }
                            maxLength={64}
                          />
                        </Td>
                        <Td>
                          <TextInput
                            size="sm"
                            aria-label={`Название (RU) для ${type.slug}`}
                            value={editDraft.label_ru}
                            onChange={(e) =>
                              setEditDraft((d) => ({ ...d, label_ru: e.target.value }))
                            }
                            maxLength={64}
                          />
                        </Td>
                        <Td>
                          <Select
                            size="sm"
                            aria-label={`Иконка для ${type.slug}`}
                            value={editDraft.icon}
                            onChange={(e) => setEditDraft((d) => ({ ...d, icon: e.target.value }))}
                          >
                            {MARK_TYPE_ICONS.map((icon) => (
                              <option key={icon} value={icon}>
                                {icon}
                              </option>
                            ))}
                          </Select>
                        </Td>
                        <Td>
                          <Select
                            size="sm"
                            aria-label={`Тяжесть для ${type.slug}`}
                            value={editDraft.severity}
                            onChange={(e) =>
                              setEditDraft((d) => ({ ...d, severity: Number(e.target.value) }))
                            }
                          >
                            {SEVERITY_OPTIONS.map((severity) => (
                              <option key={severity} value={severity}>
                                {severity}
                              </option>
                            ))}
                          </Select>
                        </Td>
                      </>
                    ) : (
                      <>
                        <Td className="text-ink-2">{type.label_en}</Td>
                        <Td>{type.label_ru}</Td>
                        <Td className="font-mono text-xs text-ink-2">{type.icon}</Td>
                        <Td className="text-ink-2">
                          {type.severity} — {severityLabel(type.severity)}
                        </Td>
                      </>
                    )}
                    <Td>
                      {type.is_active ? (
                        <Badge tone="good">активен</Badge>
                      ) : (
                        <Badge tone="neutral">деактивирован</Badge>
                      )}
                    </Td>
                    {canEdit ? (
                      <Td align="right" className="whitespace-nowrap">
                        <span className="inline-flex items-center gap-2">
                          {isEditing ? (
                            <>
                              <Button
                                size="sm"
                                variant="primary"
                                disabled={busy}
                                onClick={() => void saveEdit(type.id)}
                              >
                                Сохранить
                              </Button>
                              <Button size="sm" onClick={() => setEditingId(null)}>
                                Отмена
                              </Button>
                            </>
                          ) : (
                            <>
                              <Button size="sm" disabled={busy} onClick={() => startEdit(type)}>
                                Изменить
                              </Button>
                              <Button
                                size="sm"
                                disabled={busy}
                                onClick={() => void toggleActive(type)}
                              >
                                {type.is_active ? 'Деактивировать' : 'Активировать'}
                              </Button>
                            </>
                          )}
                        </span>
                      </Td>
                    ) : null}
                  </>
                );

                // Перетаскивание живёт на самой строке, а `TableRow` обработчиков
                // не принимает — поэтому подвижная строка собрана вручную, с теми
                // же классами, что даёт примитив.
                return canEdit && !isEditing ? (
                  <tr
                    key={type.id}
                    draggable
                    onDragStart={() => setDragIndex(index)}
                    onDragOver={(e) => {
                      if (dragIndex !== null) e.preventDefault();
                    }}
                    onDrop={() => handleDrop(index)}
                    className={`h-9 transition-colors hover:bg-raised/40 ${
                      dragIndex === index ? 'opacity-40' : ''
                    }`}
                  >
                    {cells}
                  </tr>
                ) : (
                  <TableRow key={type.id}>{cells}</TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Card>
    </PageContainer>
  );
}
