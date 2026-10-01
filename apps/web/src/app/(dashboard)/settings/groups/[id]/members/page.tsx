'use client';

import type { RoleColor } from '@squad/shared-config/role-colors';
import Link from 'next/link';
import { use, useCallback, useEffect, useRef, useState } from 'react';
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
import { ApiError, apiFetch, apiSend } from '@/lib/api';
import { useApiResource } from '@/lib/use-polled-resource';

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

/** Bounds of `/api/v1/players/search`'s `q` parameter (server `searchQuery`). */
const PLAYER_SEARCH_MIN_LENGTH = 3;
const PLAYER_SEARCH_MAX_LENGTH = 64;

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

const ACTION_ERROR_LABELS: Record<string, string> = {
  forbidden: 'недостаточно прав',
  role_not_found: 'роль не найдена',
  target_role_not_found: 'целевая роль не найдена',
  target_role_same_as_source: 'нельзя переместить в ту же роль',
  player_not_found: 'игрок не найден в базе',
  owner_assignment_forbidden: 'нельзя назначать или перемещать участников в роль Owner',
  cannot_change_own_role: 'нельзя менять собственную роль',
  role_exceeds_actor_permissions: 'роль шире ваших прав',
  target_outranks_actor: 'у участника права выше ваших',
  owner_role_immutable: 'роль Owner нельзя изменять',
  cannot_remove_last_owner: 'нельзя снять роль с последнего владельца',
  too_many_rows: 'слишком много строк в файле',
};

/**
 * Builds the banner text for a failed member action, translating the API
 * error codes the members routes return; unknown codes are shown verbatim.
 *
 * @param failure Russian description of the attempted action.
 * @param code Error code from the response body, if any.
 * @param status HTTP status used when the body carries no code.
 */
function actionErrorText(failure: string, code: unknown, status: number): string {
  if (typeof code === 'string') return `${failure}: ${ACTION_ERROR_LABELS[code] ?? code}`;
  return `${failure}: ${status}`;
}

const NETWORK_ERROR_TEXT = 'сетевая ошибка, проверьте соединение и повторите';

const NO_ROLES: RoleOption[] = [];

export default function RoleMembersPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [data, setData] = useState<MembersResponse | null>(null);
  const { data: me = null } = useApiResource<Me>('/api/v1/me');
  const { data: roles = NO_ROLES } = useApiResource<RoleOption[]>('/api/v1/roles');
  const [q, setQ] = useState('');
  const [offset, setOffset] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pendingRemove, setPendingRemove] = useState<Member | null>(null);
  const [pendingBulkRemove, setPendingBulkRemove] = useState(false);

  const latestLoad = useRef(0);

  /** Loads the current page; a response that is no longer the latest request is dropped. */
  const load = useCallback(async () => {
    const requestId = ++latestLoad.current;
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
    if (q.trim()) params.set('q', q.trim());
    try {
      const body = await apiFetch<MembersResponse>(`/api/v1/roles/${id}/members?${params}`);
      if (requestId !== latestLoad.current) return;
      setSelected(new Set());
      setData(body);
    } catch (e) {
      if (requestId !== latestLoad.current) return;
      setErr(e instanceof ApiError ? `HTTP ${e.status}` : 'Сетевая ошибка');
    }
  }, [id, offset, q]);

  useEffect(() => {
    void load();
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

  /**
   * Runs a mutating request and reports a failure in the dismissible action
   * banner, without replacing the page. Resolves to whether the request succeeded.
   */
  async function runAction(failure: string, request: () => Promise<void>): Promise<boolean> {
    setActionErr(null);
    try {
      await request();
      return true;
    } catch (e) {
      if (e instanceof ApiError) {
        const body = e.jsonBody<Record<string, unknown>>() ?? {};
        setActionErr(actionErrorText(failure, body.error, e.status));
      } else {
        setActionErr(`${failure}: ${NETWORK_ERROR_TEXT}`);
      }
    }
    return false;
  }

  async function removeMember(playerId: string) {
    if (!canManage) return;
    setPendingRemove(null);
    const ok = await runAction('Ошибка', () =>
      apiSend(`/api/v1/roles/${id}/members/${playerId}`, { method: 'DELETE' }),
    );
    if (ok) await load();
  }

  async function addMember(playerId: string) {
    const ok = await runAction('Ошибка', () =>
      apiSend(`/api/v1/roles/${id}/members`, { method: 'POST', json: { player_id: playerId } }),
    );
    if (!ok) return;
    setAddOpen(false);
    await load();
  }

  async function bulkDelete() {
    if (!canManage || selected.size === 0) return;
    setPendingBulkRemove(false);
    const ok = await runAction('Ошибка', () =>
      apiSend(`/api/v1/roles/${id}/members/bulk-delete`, {
        method: 'POST',
        json: { player_ids: [...selected] },
      }),
    );
    if (ok) await load();
  }

  async function moveSelected(targetRoleId: string) {
    const ok = await runAction('Ошибка перемещения', () =>
      apiSend(`/api/v1/roles/${id}/members/move`, {
        method: 'POST',
        json: { player_ids: [...selected], target_role_id: targetRoleId },
      }),
    );
    if (!ok) return;
    setMoveOpen(false);
    await load();
  }

  async function exportCsv() {
    setActionErr(null);
    let blob: Blob;
    try {
      const r = await fetch(`/api/v1/roles/${id}/members/export`, { credentials: 'include' });
      if (!r.ok) {
        setActionErr(`Ошибка экспорта: ${r.status}`);
        return;
      }
      blob = await r.blob();
    } catch {
      setActionErr(`Ошибка экспорта: ${NETWORK_ERROR_TEXT}`);
      return;
    }
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
          description="Не удалось загрузить список участников."
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

      {actionErr ? (
        <InlineBanner
          tone="crit"
          title={actionErr}
          onDismiss={() => setActionErr(null)}
          dismissLabel="Закрыть сообщение об ошибке"
        />
      ) : null}

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
          count={selected.size}
          roles={roles.filter((r) => r.id !== id && !(r.is_system_role && r.name === 'Owner'))}
          onClose={() => setMoveOpen(false)}
          onMove={moveSelected}
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
    try {
      await apiSend(`/api/v1/roles/${roleId}/members/import`, {
        method: 'POST',
        json: { csv },
      });
      onImported();
    } catch (e) {
      if (!(e instanceof ApiError)) {
        setTopError(NETWORK_ERROR_TEXT);
        return;
      }
      const body = e.jsonBody<{ error?: string; errors?: ImportRowError[] }>() ?? {};
      if (e.status === 422 && Array.isArray(body.errors)) {
        setErrors(body.errors);
        return;
      }
      setTopError(
        body.error ? (ACTION_ERROR_LABELS[body.error] ?? body.error) : `HTTP ${e.status}`,
      );
    } finally {
      setBusy(false);
    }
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
  const [searchErr, setSearchErr] = useState<string | null>(null);
  const trimmed = q.trim();
  const queryTooShort = trimmed.length < PLAYER_SEARCH_MIN_LENGTH;

  useEffect(() => {
    setSearchErr(null);
    if (queryTooShort) {
      setResults([]);
      return;
    }
    const controller = new AbortController();
    const handler = setTimeout(async () => {
      const url = `/api/v1/players/search?q=${encodeURIComponent(trimmed.slice(0, PLAYER_SEARCH_MAX_LENGTH))}`;
      try {
        const found = await apiFetch<{ items: PlayerSearchItem[] }>(url, {
          signal: controller.signal,
        });
        setResults(found.items);
      } catch (e) {
        if (controller.signal.aborted) return;
        setResults([]);
        setSearchErr(
          `Не удалось выполнить поиск: ${e instanceof ApiError ? e.status : NETWORK_ERROR_TEXT}`,
        );
      }
    }, 250);
    return () => {
      clearTimeout(handler);
      controller.abort();
    };
  }, [trimmed, queryTooShort]);

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
          {searchErr ? (
            <li className="py-2 text-xs text-crit">{searchErr}</li>
          ) : results.length === 0 ? (
            <li className="py-2 text-xs text-ink-3">
              {queryTooShort
                ? `Введите хотя бы ${PLAYER_SEARCH_MIN_LENGTH} символа для поиска…`
                : 'Игроки не найдены.'}
            </li>
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
