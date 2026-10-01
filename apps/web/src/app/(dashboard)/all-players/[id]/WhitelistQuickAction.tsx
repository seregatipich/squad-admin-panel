'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertDialog, Button, Card, CardBody, CardHeader, InlineBanner } from '@/components/ui';
import { ApiError, apiFetch, apiSend, nullOnHttpError } from '@/lib/api';
import type { SingleRole } from './player-detail';

interface WhitelistSettings {
  whitelist_role_id: string | null;
  whitelist_role_name: string | null;
}

const WHITELIST_ERROR_TEXT: Record<string, string> = {
  owner_role_protected: 'Роль владельца панели нельзя заменить через whitelist.',
  role_assignment_forbidden:
    'Заменить роль игрока может только пользователь с правом управления ролями.',
  whitelist_role_not_configured: 'Роль whitelist не настроена.',
};

/**
 * One-click "add to / remove from whitelist" action (WL-1, #65). Assigning or
 * removing the whitelist role is idempotent server-side, so this component
 * only needs to know the configured whitelist role and the player's current
 * role. The API never replaces an Owner's role here and requires
 * `user:manage_roles` to replace any other role (#8), so the add button is
 * offered only for a roleless player, or — after a confirmation naming the
 * role being replaced — to a role manager.
 */
export function WhitelistQuickAction({
  playerId,
  canEdit,
  canManageRoles,
  roleRefreshKey,
  onRoleChanged,
}: {
  playerId: string;
  canEdit: boolean;
  canManageRoles: boolean;
  roleRefreshKey: number;
  onRoleChanged: () => void;
}) {
  const [settings, setSettings] = useState<WhitelistSettings | null>(null);
  const [current, setCurrent] = useState<SingleRole | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [loadErr, setLoadErr] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [loadedSettings, loadedRole] = await Promise.all([
        apiFetch<WhitelistSettings>('/api/v1/whitelist/settings').catch(nullOnHttpError),
        apiFetch<{ role: SingleRole | null }>(`/api/v1/players/${playerId}/role`).catch(
          nullOnHttpError,
        ),
      ]);
      if (loadedSettings) setSettings(loadedSettings);
      if (loadedRole) setCurrent(loadedRole.role);
      setLoadErr(false);
    } catch {
      setLoadErr(true);
    }
  }, [playerId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: roleRefreshKey is a deliberate re-check trigger, not read in the effect body — bumped by PanelAccessSection so both sections agree on the role (#477)
  useEffect(() => {
    void reload();
  }, [reload, roleRefreshKey]);

  if (loadErr && !settings) {
    return (
      <Card as="section" padding="none">
        <CardHeader title="Whitelist" />
        <CardBody>
          <InlineBanner
            tone="crit"
            title="Не удалось загрузить статус whitelist"
            action={
              <Button size="sm" onClick={() => void reload()}>
                Повторить
              </Button>
            }
          />
        </CardBody>
      </Card>
    );
  }

  if (!settings?.whitelist_role_id) return null;

  const isWhitelisted = current?.id === settings.whitelist_role_id;
  const otherRole = current && !isWhitelisted ? current : null;
  const otherRoleIsOwner = otherRole?.is_system_role === true && otherRole.name === 'Owner';
  const canToggle = canEdit && (!otherRole || (canManageRoles && !otherRoleIsOwner));

  let description = isWhitelisted ? 'Игрок в whitelist.' : 'Игрок не в whitelist.';
  if (otherRole && otherRoleIsOwner) {
    description = `Игрок не в whitelist: у него роль «${otherRole.name}», её нельзя заменить через whitelist.`;
  } else if (otherRole && canEdit && !canManageRoles) {
    description = `Игрок не в whitelist: у него роль «${otherRole.name}». Заменить её может только пользователь с правом управления ролями.`;
  }

  async function toggle() {
    setBusy(true);
    setMsg(null);
    try {
      try {
        if (isWhitelisted) {
          await apiSend(`/api/v1/whitelist/members/${playerId}`, { method: 'DELETE' });
        } else {
          await apiSend('/api/v1/whitelist/members', {
            method: 'POST',
            json: { player_id: playerId },
          });
        }
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        const body = e.jsonBody<{ error?: string }>() ?? {};
        throw new Error(
          (body.error && WHITELIST_ERROR_TEXT[body.error]) ?? body.error ?? `HTTP ${e.status}`,
        );
      }
      await reload();
      onRoleChanged();
      setMsg({ kind: 'ok', text: isWhitelisted ? 'Убран из whitelist.' : 'Добавлен в whitelist.' });
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card as="section" padding="none">
      <CardHeader
        title="Whitelist"
        description={description}
        actions={
          canToggle ? (
            <Button
              size="sm"
              loading={busy}
              onClick={() => (otherRole ? setConfirmOpen(true) : void toggle())}
            >
              {isWhitelisted ? 'Убрать из whitelist' : 'В whitelist'}
            </Button>
          ) : undefined
        }
      />
      {msg ? (
        <CardBody>
          <InlineBanner
            tone={msg.kind === 'ok' ? 'good' : 'crit'}
            title={msg.text}
            onDismiss={() => setMsg(null)}
            dismissLabel="Скрыть сообщение"
          />
        </CardBody>
      ) : null}
      {otherRole ? (
        <AlertDialog
          open={confirmOpen}
          onClose={() => setConfirmOpen(false)}
          title="Добавить в whitelist"
          body={`Роль «${otherRole.name}» будет заменена ролью whitelist «${settings.whitelist_role_name ?? 'whitelist'}», вместе с доступом, который она давала.`}
          confirmLabel="Заменить роль"
          cancelLabel="Отмена"
          tone="destructive"
          busy={busy}
          onConfirm={async () => {
            await toggle();
            setConfirmOpen(false);
          }}
        />
      ) : null}
    </Card>
  );
}
