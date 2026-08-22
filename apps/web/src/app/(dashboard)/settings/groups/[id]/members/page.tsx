'use client';

import type { RoleColor } from '@squad/shared-config/role-colors';
import Link from 'next/link';
import { use, useCallback, useEffect, useState } from 'react';
import { RoleColorDot } from '@/components/RoleColorDot';
import {
  AlertDialog,
  Button,
  Card,
  Checkbox,
  EmptyState,
  InlineBanner,
  Modal,
  PageHeader,
  Pagination,
  SearchField,
  Select,
  SkeletonTable,
  Table,
  TableBody,
  TableHead,
  TableRow,
  Td,
  Textarea,
  TextInput,
  Th,
  Toolbar,
} from '@/components/ui';

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

const PAGINATION_LABELS = {
  previous: 'Назад',
  next: 'Вперёд',
  page: (page: number, of: number) => `Страница ${page} из ${of}`,
};

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
  const [pendingRemove, setPendingRemove] = useState<Member | null>(null);
  const [pendingBulkRemove, setPendingBulkRemove] = useState(false);

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

  async function removeMember(playerId: string) {
    if (!canManage) return;
    setErr(null);
    setPendingRemove(null);
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
    setErr(null);
    setPendingBulkRemove(false);
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
      <>
        <Link href="/settings/groups" className="text-xs text-accent no-underline">
          ← Назад к списку ролей
        </Link>
        <InlineBanner
          tone="crit"
          title={err}
          description="Запрос к API не выполнился."
          action={
            <Button
              size="sm"
              onClick={() => {
                setErr(null);
                void load();
              }}
            >
              Повторить
            </Button>
          }
        />
      </>
    );
  }

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;
  const allOnPageSelected =
    data !== null && data.items.length > 0 && data.items.every((m) => selected.has(m.id));

  return (
    <>
      <PageHeader
        backHref="/settings/groups"
        backLabel="Назад к списку ролей"
        title={
          <span className="inline-flex items-center gap-2">
            <RoleColorDot color={(data?.role.color ?? 'neutral') as RoleColor | string} />
            {data?.role.name ?? 'Роль'}
          </span>
        }
        meta={data ? <span>{data.total} участников</span> : null}
        actions={
          <>
            <Button onClick={() => void exportCsv()}>Экспорт CSV</Button>
            {canManage ? (
              <>
                <Button onClick={() => setImportOpen(true)}>Импорт CSV</Button>
                <Button variant="primary" onClick={() => setAddOpen(true)}>
                  Добавить игрока
                </Button>
              </>
            ) : null}
          </>
        }
      />

      <Toolbar
        search={
          <SearchField
            value={q}
            onCommit={(next) => {
              setQ(next);
              setOffset(0);
            }}
            label="Поиск по участникам роли"
            placeholder="Поиск по нику или SteamID64…"
            clearLabel="Очистить поиск"
          />
        }
        summary={data ? `Найдено: ${data.total}` : undefined}
      />

      {canManage && selected.size > 0 ? (
        <div
          data-testid="bulk-toolbar"
          className="flex items-center gap-2 rounded-card border border-line bg-surface px-3 py-2"
        >
          <span className="text-xs text-ink-2">Выбрано: {selected.size}</span>
          {/* Снятие роли обратимо — её выдают заново тем же экраном, — поэтому
              кнопки вторичные, а не критические (дизайн-система, §5). */}
          <Button size="sm" onClick={() => setPendingBulkRemove(true)}>
            Удалить выбранных
          </Button>
          <Button size="sm" onClick={() => setMoveOpen(true)}>
            Переместить в роль
          </Button>
        </div>
      ) : null}

      <Card padding="none">
        {data === null ? (
          <div className="p-3">
            <SkeletonTable rows={6} cols={5} label="Загрузка списка участников" />
          </div>
        ) : data.items.length === 0 ? (
          <EmptyState
            variant={q.trim() ? 'filtered' : 'initial'}
            title={q.trim() ? 'Никто не найден по запросу' : 'Нет участников'}
            description={
              q.trim()
                ? 'Ни один участник роли не подходит под запрос.'
                : 'Роль ещё никому не выдана. Добавьте игрока, чтобы он получил её права.'
            }
            action={
              q.trim() ? (
                <Button size="sm" onClick={() => setQ('')}>
                  Сбросить фильтр
                </Button>
              ) : null
            }
          />
        ) : (
          <Table layout="fixed" ariaLabel="Участники роли">
            <TableHead>
              <tr>
                {canManage ? (
                  <Th width="2.75rem">
                    <Checkbox
                      label={<span className="sr-only">Выбрать всех на странице</span>}
                      checked={allOnPageSelected}
                      onChange={() => toggleAll(data.items)}
                    />
                  </Th>
                ) : null}
                <Th>Никнейм</Th>
                <Th width="11rem">SteamID64</Th>
                <Th width="13rem">Комментарий</Th>
                <Th width="11rem">Был(а)</Th>
                <Th align="right" width="7rem">
                  Действие
                </Th>
              </tr>
            </TableHead>
            <TableBody>
              {data.items.map((m) => (
                <TableRow key={m.id} interactive selected={selected.has(m.id)}>
                  {canManage ? (
                    <Td>
                      <Checkbox
                        label={<span className="sr-only">{`Выбрать ${m.canonical_name}`}</span>}
                        checked={selected.has(m.id)}
                        onChange={() => toggleOne(m.id)}
                      />
                    </Td>
                  ) : null}
                  <Td truncate>
                    <Link
                      href={`/all-players/${m.id}`}
                      className="text-accent no-underline hover:brightness-110"
                    >
                      {m.canonical_name}
                    </Link>
                  </Td>
                  <Td className="font-mono text-xs">{m.steam_id64 ?? '—'}</Td>
                  <Td truncate className="text-xs text-ink-3">
                    {m.role_comment ?? '—'}
                  </Td>
                  <Td className="text-xs text-ink-3">
                    {new Date(m.last_seen_at).toLocaleString('ru-RU')}
                  </Td>
                  <Td align="right">
                    {canManage ? (
                      <Button size="sm" onClick={() => setPendingRemove(m)}>
                        Снять
                      </Button>
                    ) : null}
                  </Td>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {/* Пустая страница за пределами выдачи — не повод отнимать навигацию:
          иначе со второй страницы, опустевшей после снятия ролей, некуда
          вернуться. А вот пока список ещё грузится, показывать нечем. */}
      {data !== null && data.total > 0 ? (
        <div className="flex justify-end">
          <Pagination
            page={currentPage}
            pageCount={totalPages}
            onChange={(page) => setOffset((page - 1) * PAGE_SIZE)}
            labels={PAGINATION_LABELS}
            allowJump
          />
        </div>
      ) : null}

      <AlertDialog
        open={pendingRemove !== null}
        onClose={() => setPendingRemove(null)}
        title="Снять роль"
        body={
          pendingRemove
            ? `Игрок «${pendingRemove.canonical_name}» потеряет эту роль. Выдать её заново можно в любой момент.`
            : ''
        }
        confirmLabel="Снять роль"
        cancelLabel="Отмена"
        tone="default"
        onConfirm={() => {
          if (pendingRemove) void removeMember(pendingRemove.id);
        }}
      />

      <AlertDialog
        open={pendingBulkRemove}
        onClose={() => setPendingBulkRemove(false)}
        title="Снять роль с выбранных"
        body={`Роль потеряют ${selected.size} игроков. Выдать её заново можно в любой момент.`}
        confirmLabel="Снять роль"
        cancelLabel="Отмена"
        tone="default"
        onConfirm={() => void bulkDelete()}
      />

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
    </>
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
    <Modal
      open
      onClose={onClose}
      title="Импорт из CSV"
      closeLabel="Закрыть"
      // Внутри окна лежит набранный файл: случайный Escape стёр бы его без
      // единого вопроса, поэтому мягкие жесты закрытия выключены.
      dismissible={false}
      footer={
        <>
          <Button onClick={onClose}>Отмена</Button>
          <Button
            variant="primary"
            onClick={() => void submit()}
            loading={busy}
            disabled={csv.trim().length === 0}
          >
            Импортировать
          </Button>
        </>
      }
    >
      <div data-testid="import-modal" className="space-y-2">
        <p className="text-xs text-ink-3">
          Одна строка на игрока: <code>SteamID64</code>, необязательный комментарий после{' '}
          <code>;</code>. Если хотя бы одна строка некорректна, не импортируется ничего.
        </p>
        <Textarea
          data-testid="import-textarea"
          value={csv}
          onChange={(e) => setCsv(e.target.value)}
          placeholder={'76561198000000000;основной состав\n76561198000000001'}
          rows={8}
          aria-label="Строки CSV"
          className="font-mono"
        />
        {topError ? <InlineBanner tone="crit" title={`Ошибка: ${topError}`} /> : null}
        {errors.length > 0 ? (
          <div data-testid="import-errors">
            <InlineBanner
              tone="crit"
              title={`Файл отклонён — исправьте ${errors.length} строк(и) и повторите:`}
              description={
                <ul className="space-y-0.5">
                  {errors.map((e) => (
                    <li key={`${e.line}-${e.steam_id64}`}>
                      Строка {e.line} («{e.steam_id64}»):{' '}
                      {IMPORT_REASON_LABELS[e.reason] ?? e.reason}
                    </li>
                  ))}
                </ul>
              }
            />
          </div>
        ) : null}
      </div>
    </Modal>
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
    <Modal
      open
      onClose={onClose}
      title={`Переместить в роль (${count})`}
      size="sm"
      closeLabel="Закрыть"
      footer={
        <>
          <Button onClick={onClose}>Отмена</Button>
          <Button
            variant="primary"
            onClick={() => target && void onMove(target)}
            disabled={target === ''}
          >
            Переместить
          </Button>
        </>
      }
    >
      <div data-testid="move-modal">
        <Select
          aria-label="Целевая роль"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
        >
          <option value="">— выберите роль —</option>
          {roles.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </Select>
      </div>
    </Modal>
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
    <Modal open onClose={onClose} title="Добавить игрока" closeLabel="Закрыть">
      <div className="space-y-3">
        <TextInput
          type="search"
          placeholder="Ник или SteamID64…"
          aria-label="Поиск игрока"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <ul className="max-h-80 divide-y divide-line overflow-auto">
          {results.length === 0 ? (
            <li className="py-2 text-xs text-ink-3">Введите хотя бы 2 символа для поиска…</li>
          ) : null}
          {results.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-3 py-2">
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-[13px]">{r.canonical_name}</span>
                <span className="font-mono text-2xs text-ink-3">{r.steam_id64 ?? '—'}</span>
              </div>
              <Button size="sm" variant="primary" onClick={() => onAdd(r)}>
                Назначить
              </Button>
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}
