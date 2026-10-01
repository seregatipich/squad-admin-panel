'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import { RoleColorDot } from '@/components/RoleColorDot';
import { RoleExpiryDateField } from '@/components/RoleExpiryDateField';
import {
  AlertDialog,
  Badge,
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  FieldRow,
  InlineBanner,
  Select,
  Textarea,
} from '@/components/ui';
import { ApiError, apiFetch, apiSend, nullOnHttpError } from '@/lib/api';
import {
  buildRoleAssignPayload,
  DEFAULT_VIP_EXPIRY_WINDOWS_DAYS,
  formatRoleExpiryLabel,
  isRoleExpirySoon,
  toRoleExpiryDateValue,
} from '@/lib/role-expiry';
import type { SingleRole } from './player-detail';

const ROLE_ACTION_ERROR_TEXT: Record<string, string> = {
  owner_assignment_forbidden: 'Нельзя выдать роль Owner через UI.',
  cannot_change_own_role: 'Нельзя менять собственную роль.',
  role_exceeds_actor_permissions: 'Эта роль шире ваших прав — выдать её нельзя.',
  target_outranks_actor: 'У игрока права выше ваших — менять его роль нельзя.',
  cannot_remove_last_owner:
    'Это последний Owner панели — сначала назначьте другого Owner, прежде чем снимать роль.',
  forbidden: 'Недостаточно прав для этого действия.',
};

function roleActionErrorText(error: string | undefined, status: number): string {
  if (error && ROLE_ACTION_ERROR_TEXT[error]) return ROLE_ACTION_ERROR_TEXT[error];
  return `Недостаточно прав для этого действия (HTTP ${status}).`;
}

/**
 * Role card of the player detail page: shows the single panel role with its
 * expiry and comment, and lets a role manager assign, change or remove it.
 * `roleRefreshKey` is bumped by the whitelist action so both cards agree on
 * the role (#477).
 */
export function PanelAccessSection({
  playerId,
  canManage,
  roleRefreshKey,
  onRoleChanged,
}: {
  playerId: string;
  canManage: boolean;
  roleRefreshKey: number;
  onRoleChanged: () => void;
}) {
  const [current, setCurrent] = useState<SingleRole | null>(null);
  const [editing, setEditing] = useState(false);
  const [allRoles, setAllRoles] = useState<SingleRole[]>([]);
  const [picked, setPicked] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [loadErr, setLoadErr] = useState(false);
  const commentHintId = useId();

  const reload = useCallback(async () => {
    try {
      const [loadedRole, loadedRoles] = await Promise.all([
        apiFetch<{ role: SingleRole | null }>(`/api/v1/players/${playerId}/role`).catch(
          nullOnHttpError,
        ),
        // Only managers need the full role list; viewers don't query it.
        canManage
          ? apiFetch<SingleRole[]>('/api/v1/roles').catch(nullOnHttpError)
          : Promise.resolve(null),
      ]);
      if (loadedRole) setCurrent(loadedRole.role);
      if (loadedRoles) setAllRoles(loadedRoles);
      setLoadErr(false);
    } catch {
      setLoadErr(true);
    }
  }, [playerId, canManage]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: roleRefreshKey is a deliberate re-check trigger, not read in the effect body — bumped by WhitelistQuickAction so both sections agree on the role (#477)
  useEffect(() => {
    void reload();
  }, [reload, roleRefreshKey]);

  useEffect(() => {
    if (!editing) return;
    setExpiresAt(toRoleExpiryDateValue(current?.role_expires_at));
    setComment(current?.role_comment ?? '');
  }, [editing, current?.role_expires_at, current?.role_comment]);

  // 2.6.4 — dropdown excludes Owner and the player's current role; the
  // backend also rejects Owner assignment with 403 owner_assignment_forbidden.
  const assignableRoles = allRoles.filter(
    (r) => !(r.is_system_role && r.name === 'Owner') && r.id !== current?.id,
  );

  async function save(roleId: string | null) {
    setBusy(true);
    setMsg(null);
    try {
      try {
        if (roleId === null) {
          await apiSend(`/api/v1/players/${playerId}/role`, { method: 'DELETE' });
        } else {
          await apiSend(`/api/v1/players/${playerId}/role`, {
            method: 'PUT',
            json: buildRoleAssignPayload(roleId, expiresAt, comment),
          });
        }
      } catch (e) {
        if (e instanceof ApiError && (e.status === 409 || e.status === 403)) {
          const body = e.jsonBody<{ error?: string }>() ?? {};
          setMsg({ kind: 'err', text: roleActionErrorText(body.error, e.status) });
          return;
        }
        throw e instanceof ApiError ? new Error(`HTTP ${e.status}`) : e;
      }
      await reload();
      onRoleChanged();
      setEditing(false);
      setMsg({ kind: 'ok', text: 'Готово.' });
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const isOwner = current?.is_system_role === true && current.name === 'Owner';

  return (
    <Card as="section" padding="none">
      <CardHeader
        title="Роль"
        actions={
          canManage ? (
            <>
              {!isOwner ? (
                <Button size="sm" onClick={() => setEditing(true)}>
                  Выдать роль
                </Button>
              ) : null}
              {current ? (
                <Button size="sm" disabled={busy} onClick={() => setRemoveOpen(true)}>
                  Снять роль
                </Button>
              ) : null}
            </>
          ) : (
            <span className="text-xs text-ink-3">только просмотр</span>
          )
        }
      />

      <CardBody className="space-y-3">
        {loadErr ? (
          <InlineBanner
            tone="crit"
            title="Не удалось загрузить роль игрока"
            action={
              <Button size="sm" onClick={() => void reload()}>
                Повторить
              </Button>
            }
          />
        ) : null}
        {msg ? (
          <InlineBanner
            tone={msg.kind === 'ok' ? 'good' : 'crit'}
            title={msg.text}
            onDismiss={() => setMsg(null)}
            dismissLabel="Скрыть сообщение"
          />
        ) : null}

        {!editing ? (
          current ? (
            <div className="space-y-1">
              <span className="inline-flex items-center gap-2">
                <RoleColorDot color={current.color} />
                <span className="font-medium">{current.name}</span>
                {isOwner ? (
                  <Badge tone="crit" size="sm">
                    системная
                  </Badge>
                ) : null}
              </span>
              <span className="block text-xs text-ink-3">
                {formatRoleExpiryLabel(current.role_expires_at)}
                {current.role_comment ? ` · ${current.role_comment}` : ''}
              </span>
              {isRoleExpirySoon(current.role_expires_at, DEFAULT_VIP_EXPIRY_WINDOWS_DAYS) ? (
                <Badge tone="warn" size="sm">
                  истекает
                </Badge>
              ) : null}
            </div>
          ) : (
            <p className="text-[13px] text-ink-3">Роль не выдана.</p>
          )
        ) : (
          <div className="space-y-3">
            <div className="grid gap-3 md:grid-cols-[1fr_320px]">
              <FieldRow label="Новая роль" htmlFor={`role-select-${playerId}`}>
                <Select
                  id={`role-select-${playerId}`}
                  value={picked}
                  onChange={(e) => setPicked(e.target.value)}
                >
                  <option value="">— выберите —</option>
                  {assignableRoles.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </Select>
              </FieldRow>

              <FieldRow label="Срок действия" htmlFor={`role-expiry-${playerId}`}>
                <RoleExpiryDateField
                  id={`role-expiry-${playerId}`}
                  value={expiresAt}
                  onChange={setExpiresAt}
                />
              </FieldRow>
            </div>

            <FieldRow
              label="Комментарий"
              htmlFor={`role-comment-${playerId}`}
              hint={
                // Идентификатор нужен, чтобы пояснение читалось скринридером как
                // описание поля: `FieldRow` связывает с полем только текст ошибки.
                <span id={commentHintId}>
                  Необязательно. Причина выдачи видна другим администраторам в карточке игрока и
                  списках.
                </span>
              }
            >
              <Textarea
                id={`role-comment-${playerId}`}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                maxLength={512}
                rows={2}
                aria-describedby={commentHintId}
                placeholder="Например: VIP по заявке"
                className="resize-none"
              />
            </FieldRow>
          </div>
        )}
      </CardBody>

      {editing ? (
        <CardFooter>
          <Button
            variant="secondary"
            onClick={() => {
              setEditing(false);
              setPicked('');
            }}
            disabled={busy}
          >
            Отмена
          </Button>
          <Button
            variant="primary"
            onClick={() => picked && save(picked)}
            disabled={!picked}
            loading={busy}
          >
            Сохранить
          </Button>
        </CardFooter>
      ) : null}

      {current ? (
        <AlertDialog
          open={removeOpen}
          onClose={() => setRemoveOpen(false)}
          title="Снять роль"
          body={`Роль «${current.name}» будет снята с этого игрока, вместе с доступом, который она давала. Роль можно выдать заново.`}
          confirmLabel="Снять роль"
          cancelLabel="Отмена"
          tone="destructive"
          busy={busy}
          onConfirm={async () => {
            await save(null);
            setRemoveOpen(false);
          }}
        />
      ) : null}
    </Card>
  );
}
