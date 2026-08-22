'use client';
import type { RoleColor } from '@squad/shared-config/role-colors';
import Link from 'next/link';
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { RoleColorDot } from '@/components/RoleColorDot';
import { RoleExpiryDateField } from '@/components/RoleExpiryDateField';
import {
  AlertDialog,
  Badge,
  Button,
  Card,
  EmptyState,
  FieldRow,
  InlineBanner,
  Modal,
  PageContainer,
  PageHeader,
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
import { buildRoleAssignPayload, formatRoleExpiryLabel } from '@/lib/role-expiry';

interface UserRow {
  id: string;
  steam_id64: string | null;
  canonical_name: string;
  last_seen_at: string;
  role: { id: string; name: string; color: RoleColor; is_system_role: boolean };
  role_expires_at: string | null;
  role_comment: string | null;
  /** DISCORD-4 (#151): boolean only — the raw Discord id never reaches this list. */
  discord_linked?: boolean;
}
interface RoleOption {
  id: string;
  name: string;
  color: RoleColor;
  is_system_role: boolean;
}
interface Me {
  permissions: string[];
}
interface PlayerHit {
  id: string;
  steam_id64: string | null;
  canonical_name: string;
}

/** Кого именно оператор попросил лишить роли — заголовок и текст диалога. */
interface PendingUnassign {
  id: string;
  name: string;
}

export default function UsersPage() {
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [roleOptions, setRoleOptions] = useState<RoleOption[] | null>(null);
  const [showAssign, setShowAssign] = useState(false);
  const [q, setQ] = useState('');
  const [filterRoleId, setFilterRoleId] = useState('');
  const [pendingUnassign, setPendingUnassign] = useState<PendingUnassign | null>(null);
  const [unassignBusy, setUnassignBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const roleFilterId = useId();

  const load = useCallback(async () => {
    const url = new URL('/api/v1/users', window.location.origin);
    if (q.trim()) url.searchParams.set('q', q.trim());
    if (filterRoleId) url.searchParams.set('role_id', filterRoleId);
    const path = url.toString().replace(window.location.origin, '');
    const r = await fetch(path, { credentials: 'include', cache: 'no-store' });
    if (r.ok) setUsers((await r.json()) as UserRow[]);
    const m = await fetch('/api/v1/me', { credentials: 'include', cache: 'no-store' });
    if (m.ok) setMe((await m.json()) as Me);
    const ro = await fetch('/api/v1/roles', { credentials: 'include', cache: 'no-store' });
    if (ro.ok) setRoleOptions((await ro.json()) as RoleOption[]);
  }, [q, filterRoleId]);

  useEffect(() => {
    void load();
  }, [load]);

  const canManage = me?.permissions.includes('user:manage_roles') ?? false;

  async function unassign({ id }: PendingUnassign) {
    if (!canManage) return;
    setUnassignBusy(true);
    setActionError(null);
    try {
      const r = await fetch(`/api/v1/players/${id}/role`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!r.ok) {
        const e = (await r.json().catch(() => ({}))) as { error?: string };
        // Единственный Owner — не сбой запроса, а правило панели: оператору
        // нужен следующий шаг, а не код ошибки.
        setActionError(
          r.status === 409 && e.error === 'cannot_remove_last_owner'
            ? 'Вы единственный Owner. Сначала выдайте роль Owner другому пользователю.'
            : `Ошибка: ${e.error ?? r.status}`,
        );
        return;
      }
      await load();
    } finally {
      // Диалог закрывается и после отказа: сообщение об ошибке живёт на
      // странице, а под открытым модальным окном его никто не увидит.
      setPendingUnassign(null);
      setUnassignBusy(false);
    }
  }

  const filtersApplied = q.trim() !== '' || filterRoleId !== '';
  const resetProps = filtersApplied
    ? {
        onReset: () => {
          setQ('');
          setFilterRoleId('');
        },
        resetLabel: 'Сбросить фильтр',
      }
    : {};

  return (
    <PageContainer>
      <PageHeader
        title="Пользователи панели"
        actions={
          canManage ? (
            <Button variant="primary" onClick={() => setShowAssign(true)}>
              Назначить роль игроку
            </Button>
          ) : null
        }
      />

      {actionError ? (
        <InlineBanner
          tone="crit"
          title="Не удалось снять роль"
          description={actionError}
          onDismiss={() => setActionError(null)}
          dismissLabel="Скрыть сообщение"
        />
      ) : null}

      <Toolbar
        {...resetProps}
        search={
          <SearchField
            value={q}
            onCommit={setQ}
            label="Поиск по пользователям"
            placeholder="Поиск по нику или SteamID64…"
            clearLabel="Очистить поиск"
          />
        }
        filters={
          <>
            <label htmlFor={roleFilterId} className="text-xs text-ink-3">
              Роль
            </label>
            <Select
              id={roleFilterId}
              value={filterRoleId}
              onChange={(e) => setFilterRoleId(e.target.value)}
              className="w-48"
            >
              <option value="">Все роли</option>
              {(roleOptions ?? []).map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </Select>
          </>
        }
      />

      <Card padding="none">
        {users === null || me === null ? (
          <div className="p-3">
            <SkeletonTable rows={6} cols={5} label="Загрузка списка пользователей" />
          </div>
        ) : users.length === 0 ? (
          <EmptyState
            variant={filtersApplied ? 'filtered' : 'initial'}
            title={filtersApplied ? 'Нет пользователей по фильтру' : 'Роль ещё никому не выдана'}
            description={
              filtersApplied
                ? 'Ни один пользователь не подходит под запрос и выбранную роль.'
                : 'Назначьте роль игроку, чтобы он получил доступ к панели.'
            }
          />
        ) : (
          <Table ariaLabel="Пользователи панели">
            <TableHead>
              <tr>
                <Th>Игрок</Th>
                <Th>SteamID64</Th>
                <Th>Роль</Th>
                <Th>Срок</Th>
                <Th>Был(а)</Th>
                {canManage ? (
                  <Th align="right" width="8rem">
                    Действие
                  </Th>
                ) : null}
              </tr>
            </TableHead>
            <TableBody>
              {users.map((u) => (
                <TableRow key={u.id} interactive>
                  <Td>
                    <span className="inline-flex items-center gap-2">
                      <Link
                        href={`/all-players/${u.id}`}
                        className="text-accent no-underline hover:brightness-110"
                      >
                        {u.canonical_name}
                      </Link>
                      {u.discord_linked ? (
                        <Badge tone="accent" size="sm" title="Discord-аккаунт привязан">
                          Discord
                        </Badge>
                      ) : null}
                    </span>
                  </Td>
                  <Td className="font-mono text-xs">{u.steam_id64 ?? '—'}</Td>
                  <Td>
                    <span className="inline-flex items-center gap-2">
                      <RoleColorDot color={u.role.color} />
                      {u.role.name}
                    </span>
                  </Td>
                  <Td>
                    <div>{formatRoleExpiryLabel(u.role_expires_at)}</div>
                    {u.role_comment ? (
                      <div
                        className="mt-1 max-w-56 truncate text-xs text-ink-3"
                        title={u.role_comment}
                      >
                        {u.role_comment}
                      </div>
                    ) : null}
                  </Td>
                  <Td className="text-xs text-ink-3">
                    {new Date(u.last_seen_at).toLocaleString()}
                  </Td>
                  {canManage ? (
                    <Td align="right">
                      {u.role.is_system_role && u.role.name === 'Owner' ? (
                        <span className="text-xs text-ink-3">—</span>
                      ) : (
                        <Button
                          size="sm"
                          onClick={() => setPendingUnassign({ id: u.id, name: u.canonical_name })}
                        >
                          Снять
                        </Button>
                      )}
                    </Td>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {/* Снятие роли обратимо — её выдают заново тем же диалогом, — поэтому
          подтверждение обычное, а не критическое (дизайн-система, §5). */}
      <AlertDialog
        open={pendingUnassign !== null}
        onClose={() => {
          if (unassignBusy) return;
          setPendingUnassign(null);
        }}
        title="Снять роль"
        body={
          pendingUnassign
            ? `Пользователь «${pendingUnassign.name}» потеряет доступ к панели. Роль можно выдать заново в любой момент.`
            : ''
        }
        confirmLabel="Снять роль"
        cancelLabel="Отмена"
        tone="default"
        busy={unassignBusy}
        onConfirm={() => {
          if (pendingUnassign) void unassign(pendingUnassign);
        }}
      />

      {showAssign ? (
        <AssignModal
          onClose={() => {
            setShowAssign(false);
            void load();
          }}
        />
      ) : null}
    </PageContainer>
  );
}

function AssignModal({ onClose }: { onClose: () => void }) {
  const uid = useId();
  const playerInputId = `${uid}-player`;
  const roleSelectId = `${uid}-role`;
  const expiresInputId = `${uid}-expires`;
  const commentInputId = `${uid}-comment`;
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<PlayerHit[]>([]);
  const [picked, setPicked] = useState<PlayerHit | null>(null);
  const [roles, setRoles] = useState<RoleOption[] | null>(null);
  const [roleId, setRoleId] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/v1/roles', { credentials: 'include' })
      .then((r) => r.json())
      .then(setRoles);
  }, []);

  useEffect(() => {
    if (!q.trim()) {
      setHits([]);
      return;
    }
    const t = setTimeout(async () => {
      const r = await fetch(`/api/v1/players?q=${encodeURIComponent(q)}`, {
        credentials: 'include',
      });
      if (r.ok) {
        const body = (await r.json()) as { items: PlayerHit[] };
        setHits(body.items.slice(0, 20));
      }
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  // 2.6.4 — Owner is excluded from the assignable roles set; only the
  // first-login trick or a direct DB modification can grant it.
  const assignableRoles = useMemo(
    () => (roles ?? []).filter((r) => !(r.is_system_role && r.name === 'Owner')),
    [roles],
  );

  async function assign() {
    if (!picked || !roleId) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/v1/players/${picked.id}/role`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildRoleAssignPayload(roleId, expiresAt, comment)),
      });
      if (!r.ok) {
        const e = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(e.error ?? `HTTP ${r.status}`);
      }
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Назначить роль"
      closeLabel="Закрыть окно"
      // Внутри окна набранный поиск, выбранная роль и комментарий: случайный
      // Escape над заполненной формой стёр бы работу без единого вопроса.
      dismissible={false}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Отмена
          </Button>
          <Button variant="primary" onClick={assign} loading={busy} disabled={!picked || !roleId}>
            Назначить
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {err ? (
          <InlineBanner tone="crit" title="Не удалось назначить роль" description={err} />
        ) : null}

        <div className="space-y-1">
          <FieldRow label="Игрок" htmlFor={playerInputId}>
            <TextInput
              id={playerInputId}
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPicked(null);
              }}
              placeholder="ник или SteamID64"
            />
          </FieldRow>
          {hits.length > 0 && !picked ? (
            <ul className="max-h-40 divide-y divide-line overflow-auto rounded-ctl border border-line">
              {hits.map((h) => (
                <li key={h.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setPicked(h);
                      setHits([]);
                      setQ(h.canonical_name);
                    }}
                    className="flex min-h-8 w-full items-center gap-2 px-2.5 text-left text-xs transition-colors duration-150 hover:bg-raised"
                  >
                    <span>{h.canonical_name}</span>
                    <span className="font-mono text-2xs text-ink-3">{h.steam_id64 ?? ''}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <FieldRow label="Роль" htmlFor={roleSelectId}>
          <Select id={roleSelectId} value={roleId} onChange={(e) => setRoleId(e.target.value)}>
            <option value="">— выберите —</option>
            {assignableRoles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
        </FieldRow>

        <FieldRow label="Срок действия" htmlFor={expiresInputId}>
          <RoleExpiryDateField id={expiresInputId} value={expiresAt} onChange={setExpiresAt} />
        </FieldRow>

        <FieldRow
          label="Комментарий"
          htmlFor={commentInputId}
          hint={
            <span id={`${commentInputId}-hint`}>
              Необязательно. Причина выдачи видна другим администраторам в карточке игрока и
              списках.
            </span>
          }
        >
          <Textarea
            id={commentInputId}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            maxLength={512}
            rows={3}
            placeholder="Например: VIP по заявке"
            aria-describedby={`${commentInputId}-hint`}
          />
        </FieldRow>
      </div>
    </Modal>
  );
}
