'use client';

import type { RoleColor } from '@squad/shared-config/role-colors';
import Link from 'next/link';
import { use, useState } from 'react';
import { RoleColorDot } from '@/components/RoleColorDot';
import {
  AlertDialog,
  Button,
  InlineBanner,
  PageHeader,
  Pagination,
  SearchField,
  Toolbar,
} from '@/components/ui';
import { ApiError, apiSend } from '@/lib/api';
import { useApiResource } from '@/lib/use-polled-resource';
import { AddMemberModal } from './AddMemberModal';
import { ImportModal } from './ImportModal';
import { MembersTable } from './MembersTable';
import { MoveModal } from './MoveModal';
import {
  actionErrorText,
  type Member,
  NETWORK_ERROR_TEXT,
  PAGE_SIZE,
  type RoleOption,
} from './members-shared';
import { useRoleMembers } from './useRoleMembers';

interface Me {
  permissions: string[];
}

const PAGINATION_LABELS = {
  previous: 'Назад',
  next: 'Вперёд',
  page: (page: number, of: number) => `Страница ${page} из ${of}`,
};

const NO_ROLES: RoleOption[] = [];

export default function RoleMembersPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: me = null } = useApiResource<Me>('/api/v1/me');
  const { data: roles = NO_ROLES } = useApiResource<RoleOption[]>('/api/v1/roles');
  const { data, q, setQ, offset, setOffset, err, setErr, selected, load, toggleOne, toggleAll } =
    useRoleMembers(id);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [pendingRemove, setPendingRemove] = useState<Member | null>(null);
  const [pendingBulkRemove, setPendingBulkRemove] = useState(false);

  const canManage = me?.permissions.includes('user:manage_roles') ?? false;

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
      <MembersTable
        data={data}
        canManage={canManage}
        query={q}
        selected={selected}
        onToggleAll={toggleAll}
        onToggleOne={toggleOne}
        onRemove={setPendingRemove}
        onResetFilter={() => setQ('')}
      />

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
