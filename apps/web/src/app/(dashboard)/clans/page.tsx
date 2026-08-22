'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge,
  type BadgeTone,
  Button,
  Card,
  Checkbox,
  EmptyState,
  FieldRow,
  InlineBanner,
  Modal,
  PageContainer,
  PageHeader,
  Pagination,
  SearchField,
  Select,
  SkeletonTable,
  SortableTh,
  Table,
  TableBody,
  TableHead,
  TableRow,
  Td,
  Textarea,
  TextInput,
  Th,
  Toolbar,
  type ToolbarProps,
} from '@/components/ui';
import type { ClanSortField, BadgeTone as PriorityTone, SortOrder } from './helpers';
import { paginate, priorityBadge, sortClans } from './helpers';

interface Clan {
  id: string;
  name: string;
  tags: string[];
  description: string | null;
  member_count: number;
  priority_count: number;
  max_priority_slots: number;
  priority_expires_at: string | null;
  is_tag_protected: boolean;
  is_public: boolean;
  primary_server_id: string | null;
}

interface ClansResponse {
  items: Clan[];
  total: number;
}

interface ServerOption {
  id: string;
  display_name: string;
}

interface MeResponse {
  can_manage_clans: boolean;
}

const PAGE_SIZE = 25;

/**
 * Домашний словарь сроков приоритета (`helpers.ts`) говорит о клане, а не о
 * панели, поэтому его тон переводится в тон дизайн-системы здесь, а не в
 * помощнике: помощник ничего не знает про оформление и не должен знать.
 */
const PRIORITY_TONE: Record<PriorityTone, BadgeTone> = {
  neutral: 'neutral',
  danger: 'crit',
  warning: 'warn',
};

/** Подписи направления сортировки — часть доступного имени заголовка колонки. */
const SORT_DIRECTION_TEXT = { asc: 'по возрастанию', desc: 'по убыванию' } as const;

export default function ClansPage() {
  const router = useRouter();
  const [data, setData] = useState<ClansResponse | null>(null);
  const [servers, setServers] = useState<ServerOption[]>([]);
  const [canManageClans, setCanManageClans] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<ClanSortField>('name');
  const [order, setOrder] = useState<SortOrder>('asc');
  const [page, setPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/v1/clans', { credentials: 'include', cache: 'no-store' });
      if (!res.ok) throw new Error(`Не удалось загрузить кланы (${res.status})`);
      setData((await res.json()) as ClansResponse);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  const loadServers = useCallback(async () => {
    try {
      const res = await fetch('/api/v1/servers', { credentials: 'include', cache: 'no-store' });
      if (!res.ok) return;
      const body = (await res.json()) as { items: ServerOption[] };
      setServers(body.items);
    } catch {
      /* server names are a display nicety only */
    }
  }, []);

  const loadMe = useCallback(async () => {
    try {
      const res = await fetch('/api/v1/me', { credentials: 'include', cache: 'no-store' });
      if (!res.ok) return;
      const body = (await res.json()) as MeResponse;
      setCanManageClans(body.can_manage_clans);
    } catch {
      /* leave the create button hidden on failure */
    }
  }, []);

  useEffect(() => {
    void load();
    void loadServers();
    void loadMe();
  }, [load, loadServers, loadMe]);

  const serverNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const server of servers) map.set(server.id, server.display_name);
    return map;
  }, [servers]);

  const filtered = useMemo(() => {
    if (!data) return [];
    const needle = q.trim().toLowerCase();
    if (!needle) return data.items;
    return data.items.filter(
      (clan) =>
        clan.name.toLowerCase().includes(needle) ||
        clan.tags.some((tag) => tag.toLowerCase().includes(needle)),
    );
  }, [data, q]);

  const sorted = useMemo(() => sortClans(filtered, sort, order), [filtered, sort, order]);
  const paged = useMemo(() => paginate(sorted, page, PAGE_SIZE), [sorted, page]);

  useEffect(() => {
    setPage(1);
  }, [q, sort, order]);

  // Повторное нажатие по активной колонке разворачивает порядок, переход на
  // другую — начинает с возрастания: так стрелка в шапке всегда объясняет,
  // что именно произошло от нажатия.
  const changeSort = useCallback(
    (key: string) => {
      const field = key as ClanSortField;
      if (field === sort) {
        setOrder((prev) => (prev === 'asc' ? 'desc' : 'asc'));
        return;
      }
      setSort(field);
      setOrder('asc');
    },
    [sort],
  );

  const loading = data === null && err === null;
  const searching = q.trim().length > 0;
  const resetProps: ToolbarProps = searching
    ? { onReset: () => setQ(''), resetLabel: 'Сбросить фильтр' }
    : {};

  return (
    <PageContainer>
      <PageHeader
        title="Кланы"
        subtitle="Директория кланов: состав, слоты приоритета и привязка к серверу."
        actions={
          canManageClans ? (
            <Button variant="primary" onClick={() => setCreateOpen(true)}>
              Создать клан
            </Button>
          ) : null
        }
      />

      {err ? (
        <InlineBanner
          tone="crit"
          title="Не удалось загрузить кланы"
          description={err}
          action={
            <Button size="sm" onClick={() => void load()}>
              Повторить
            </Button>
          }
        />
      ) : null}

      <Toolbar
        search={
          <SearchField
            value={q}
            onCommit={setQ}
            label="Поиск по кланам"
            placeholder="Название или тег"
            clearLabel="Очистить поиск"
          />
        }
        {...resetProps}
        summary={data ? `Найдено ${paged.total} из ${data.total}` : undefined}
      />

      {loading ? (
        <Card padding="none">
          <SkeletonTable rows={8} cols={6} label="Загружаем кланы" />
        </Card>
      ) : paged.items.length === 0 ? (
        <Card padding="none">
          <EmptyState
            variant={searching ? 'filtered' : 'initial'}
            title={searching ? 'Ничего не нашлось' : 'Кланы ещё не созданы'}
            description={
              searching
                ? 'Ни один клан не подходит под запрос.'
                : 'Создайте первый клан, чтобы вести ростер и раздавать слоты приоритета.'
            }
            action={
              searching ? <Button onClick={() => setQ('')}>Сбросить фильтр</Button> : undefined
            }
          />
        </Card>
      ) : (
        <Card padding="none">
          <Table ariaLabel="Кланы">
            <TableHead>
              <TableRow>
                <SortableTh
                  sortKey="name"
                  activeKey={sort}
                  direction={order}
                  onSort={changeSort}
                  label="Название"
                  directionText={SORT_DIRECTION_TEXT}
                />
                <Th>Теги</Th>
                <SortableTh
                  sortKey="members"
                  activeKey={sort}
                  direction={order}
                  onSort={changeSort}
                  label="Участников"
                  directionText={SORT_DIRECTION_TEXT}
                  align="right"
                />
                <SortableTh
                  sortKey="priority"
                  activeKey={sort}
                  direction={order}
                  onSort={changeSort}
                  label="Приоритет"
                  directionText={SORT_DIRECTION_TEXT}
                  align="right"
                />
                <Th>Срок приоритета</Th>
                <Th>Основной сервер</Th>
              </TableRow>
            </TableHead>
            <TableBody>
              {paged.items.map((clan) => {
                const badge = priorityBadge(clan.priority_expires_at);
                return (
                  <TableRow key={clan.id} interactive>
                    <Td>
                      <Link
                        href={`/clans/${clan.id}`}
                        className="font-medium text-accent no-underline hover:brightness-110"
                      >
                        {clan.name}
                      </Link>
                    </Td>
                    <Td>
                      <div className="flex flex-wrap items-center gap-1">
                        {clan.tags.map((tag) => (
                          <Badge key={tag} size="sm">
                            {tag}
                          </Badge>
                        ))}
                        {clan.is_tag_protected ? (
                          <Badge size="sm" tone="good">
                            Тег защищён
                          </Badge>
                        ) : null}
                      </div>
                    </Td>
                    <Td numeric>{clan.member_count}</Td>
                    <Td numeric className="text-ink-2">
                      {clan.priority_count} / {clan.max_priority_slots}
                    </Td>
                    <Td>
                      <Badge tone={PRIORITY_TONE[badge.tone]}>{badge.label}</Badge>
                    </Td>
                    <Td className="text-ink-2">
                      {clan.primary_server_id
                        ? (serverNameById.get(clan.primary_server_id) ?? '—')
                        : '—'}
                    </Td>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      )}

      {paged.pageCount > 1 ? (
        <div className="flex justify-end">
          <Pagination
            page={paged.page}
            pageCount={paged.pageCount}
            onChange={setPage}
            labels={{
              previous: 'Назад',
              next: 'Вперёд',
              page: (current, of) => `Стр. ${current} из ${of}`,
            }}
          />
        </div>
      ) : null}

      <CreateClanModal
        open={createOpen}
        servers={servers}
        onClose={() => setCreateOpen(false)}
        onCreated={(id) => router.push(`/clans/${id}`)}
      />
    </PageContainer>
  );
}

interface CreateClanForm {
  name: string;
  description: string;
  tags: string;
  max_priority_slots: string;
  primary_server_id: string;
  is_public: boolean;
  is_tag_protected: boolean;
}

const EMPTY_CREATE_FORM: CreateClanForm = {
  name: '',
  description: '',
  tags: '',
  max_priority_slots: '10',
  primary_server_id: '',
  is_public: false,
  is_tag_protected: false,
};

function CreateClanModal({
  open,
  servers,
  onClose,
  onCreated,
}: {
  open: boolean;
  servers: ServerOption[];
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [form, setForm] = useState<CreateClanForm>(EMPTY_CREATE_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async () => {
    const name = form.name.trim();
    if (!name) {
      setError('Название не может быть пустым.');
      return;
    }
    setSubmitting(true);
    setError(null);
    const tags = form.tags
      .split(',')
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0);
    const slots = Number.parseInt(form.max_priority_slots, 10);
    try {
      const res = await fetch('/api/v1/clans', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name,
          description: form.description.trim() ? form.description.trim() : null,
          tags,
          max_priority_slots: Number.isFinite(slots) ? slots : undefined,
          primary_server_id: form.primary_server_id || null,
          is_public: form.is_public,
          is_tag_protected: form.is_tag_protected,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(`Не удалось создать клан: ${body.error ?? res.status}`);
        return;
      }
      const created = (await res.json()) as { id: string };
      onCreated(created.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }, [form, onCreated]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Новый клан"
      closeLabel="Закрыть"
      dismissible={!submitting}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            Отмена
          </Button>
          {/* Подтверждающая кнопка — справа, как требует HIG. Подвал диалога
              лежит вне `<form>`, поэтому отправку он запускает тем же
              обработчиком, что и Enter в поле. */}
          <Button
            variant="primary"
            onClick={() => void submit()}
            loading={submitting}
            disabled={!form.name.trim()}
          >
            Создать
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="space-y-4"
      >
        {error ? <InlineBanner tone="crit" title="Клан не создан" description={error} /> : null}

        <FieldRow label="Название">
          <TextInput
            value={form.name}
            maxLength={32}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          />
        </FieldRow>

        <FieldRow label="Описание" hint="Необязательно.">
          <Textarea
            value={form.description}
            maxLength={2000}
            rows={3}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
          />
        </FieldRow>

        <FieldRow label="Теги через запятую">
          <TextInput
            value={form.tags}
            placeholder="напр. TAG, ALT"
            onChange={(e) => setForm((f) => ({ ...f, tags: e.target.value }))}
          />
        </FieldRow>

        <div className="grid grid-cols-2 gap-3">
          <FieldRow label="Слотов приоритета">
            <TextInput
              type="number"
              min={0}
              max={999}
              value={form.max_priority_slots}
              onChange={(e) => setForm((f) => ({ ...f, max_priority_slots: e.target.value }))}
            />
          </FieldRow>
          <FieldRow label="Основной сервер">
            <Select
              value={form.primary_server_id}
              onChange={(e) => setForm((f) => ({ ...f, primary_server_id: e.target.value }))}
            >
              <option value="">Без привязки</option>
              {servers.map((server) => (
                <option key={server.id} value={server.id}>
                  {server.display_name}
                </option>
              ))}
            </Select>
          </FieldRow>
        </div>

        <div className="flex flex-wrap gap-4">
          <Checkbox
            label="Публичный клан"
            checked={form.is_public}
            onChange={(e) => setForm((f) => ({ ...f, is_public: e.target.checked }))}
          />
          <Checkbox
            label="Защита тега"
            checked={form.is_tag_protected}
            onChange={(e) => setForm((f) => ({ ...f, is_tag_protected: e.target.checked }))}
          />
        </div>
      </form>
    </Modal>
  );
}
