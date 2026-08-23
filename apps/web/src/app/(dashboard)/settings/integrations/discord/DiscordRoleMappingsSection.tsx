'use client';
import { useCallback, useEffect, useId, useState } from 'react';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  FieldRow,
  IconButton,
  InlineBanner,
  Select,
  SkeletonTable,
  Switch,
  Table,
  TableBody,
  TableHead,
  TableRow,
  Td,
  TextInput,
  Th,
  TrashIcon,
} from '@/components/ui';

/**
 * Panel role → Discord role mapping management (DISCORD-5, #152) on
 * `/settings/integrations/discord`.
 *
 * Gating is self-hide-on-403: `GET /api/v1/me` does not expose a
 * `can_manage_integrations` boolean, and the API already answers 403 without
 * `integration:manage`, so the section simply renders nothing rather than
 * duplicating the permission rule in the client.
 */

export interface RoleMappingRow {
  id: string;
  role_id: string;
  role_name: string | null;
  discord_role_id: string;
  source: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface RoleSyncStatus {
  state: 'ok' | 'error';
  reason: string | null;
  message: string | null;
  checked_at: string;
}

interface RoleOption {
  id: string;
  name: string;
  is_system_role: boolean;
}

/**
 * Turns the worker's last role-sync outcome into the banner text, or `null`
 * when there is nothing to warn about. The `missing_permissions` case gets its
 * own wording because it is the one failure an operator can actually fix, and
 * DISCORD-5's acceptance criteria require it to be visible rather than silent.
 */
export function roleSyncStatusText(status: RoleSyncStatus | null): string | null {
  if (!status || status.state !== 'error') return null;
  if (status.reason === 'missing_permissions') {
    return 'У бота нет права Manage Roles в Discord-гильдии — роли не выдаются.';
  }
  return status.message ?? 'Синхронизация ролей завершилась с ошибкой.';
}

const CREATE_ERRORS: Record<string, string> = {
  role_mapping_exists: 'Для этой роли панели маппинг уже существует',
  role_not_found: 'Роль панели не найдена',
};

const BASE = '/api/v1/integrations/discord/role-mappings';

async function readError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return (body.error && CREATE_ERRORS[body.error]) ?? 'Не удалось сохранить маппинг';
}

export default function DiscordRoleMappingsSection() {
  const roleSelectId = useId();
  const discordRoleInputId = useId();

  const [hidden, setHidden] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [items, setItems] = useState<RoleMappingRow[]>([]);
  const [status, setStatus] = useState<RoleSyncStatus | null>(null);
  const [roleOptions, setRoleOptions] = useState<RoleOption[]>([]);
  const [formRoleId, setFormRoleId] = useState('');
  const [formDiscordRoleId, setFormDiscordRoleId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [mappingsRes, rolesRes] = await Promise.all([
      fetch(BASE, { credentials: 'include', cache: 'no-store' }),
      fetch('/api/v1/roles', { credentials: 'include', cache: 'no-store' }),
    ]);
    if (mappingsRes.status === 403) {
      setHidden(true);
      return;
    }
    if (!mappingsRes.ok) {
      setError('Не удалось загрузить маппинги ролей');
      setLoaded(true);
      return;
    }
    const body = (await mappingsRes.json()) as {
      items: RoleMappingRow[];
      status: RoleSyncStatus | null;
    };
    setItems(body.items);
    setStatus(body.status);
    if (rolesRes.ok) setRoleOptions((await rolesRes.json()) as RoleOption[]);
    setLoaded(true);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (hidden) return null;

  const mappedRoleIds = new Set(items.map((row) => row.role_id));
  const assignableRoles = roleOptions.filter(
    (role) => !(role.is_system_role && role.name === 'Owner') && !mappedRoleIds.has(role.id),
  );

  const statusText = roleSyncStatusText(status);

  async function create() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(BASE, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role_id: formRoleId, discord_role_id: formDiscordRoleId }),
      });
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      setFormRoleId('');
      setFormDiscordRoleId('');
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function toggle(row: RoleMappingRow) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${BASE}/${row.id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: !row.enabled }),
      });
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function remove(row: RoleMappingRow) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${BASE}/${row.id}`, { method: 'DELETE', credentials: 'include' });
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function reconcile() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`${BASE}/reconcile`, { method: 'POST', credentials: 'include' });
      if (!res.ok) {
        setError('Не удалось запустить синхронизацию');
        return;
      }
      setNotice('Синхронизация поставлена в очередь');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card padding="none" as="section">
      <CardHeader
        title="Синхронизация ролей"
        description="Роль панели выдаёт указанную роль Discord каждому игроку, привязавшему Discord-аккаунт; панель — источник истины, расхождения чинит ежечасная сверка. Источник — роль панели; роли по лидербордам (топ по киллам, тиры по времени) появятся позже, после STATS-3."
        actions={
          <Button variant="secondary" size="sm" onClick={() => void reconcile()} disabled={busy}>
            Синхронизировать сейчас
          </Button>
        }
      />

      {(statusText || error || notice) && (
        <CardBody padding="sm" className="space-y-2">
          {statusText && <InlineBanner tone="crit" title={statusText} />}
          {error && <InlineBanner tone="crit" title={error} />}
          {notice && <InlineBanner tone="good" title={notice} />}
        </CardBody>
      )}

      {!loaded ? (
        <CardBody padding="sm">
          <SkeletonTable rows={3} cols={4} label="Загрузка маппингов" />
        </CardBody>
      ) : items.length === 0 ? (
        <EmptyState
          title="Маппингов пока нет"
          description="Добавьте первый маппинг ниже — роль панели начнёт выдавать роль Discord при следующей сверке."
        />
      ) : (
        <Table ariaLabel="Маппинги ролей панели на роли Discord">
          <TableHead>
            <TableRow>
              <Th>Роль панели</Th>
              <Th>ID роли Discord</Th>
              <Th>Состояние</Th>
              <Th align="right">Действия</Th>
            </TableRow>
          </TableHead>
          <TableBody>
            {items.map((row) => (
              <TableRow key={row.id}>
                <Td>{row.role_name}</Td>
                <Td className="font-mono text-ink-2">{row.discord_role_id}</Td>
                <Td>
                  <span className="flex items-center gap-2">
                    <Switch
                      checked={row.enabled}
                      disabled={busy}
                      onChange={() => void toggle(row)}
                      label={`Выдавать роль Discord для «${row.role_name ?? row.role_id}»`}
                    />
                    <span className="text-xs text-ink-3">
                      {row.enabled ? 'Включено' : 'Выключено'}
                    </span>
                  </span>
                </Td>
                <Td align="right">
                  <IconButton
                    tone="destructive"
                    size="sm"
                    onClick={() => void remove(row)}
                    disabled={busy}
                    icon={<TrashIcon />}
                    label={`Удалить маппинг «${row.role_name ?? row.role_id}»`}
                  />
                </Td>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <CardBody className="space-y-4 border-t border-line">
        <div className="grid gap-4 sm:grid-cols-2">
          <FieldRow label="Роль панели" htmlFor={roleSelectId}>
            <Select
              id={roleSelectId}
              value={formRoleId}
              onChange={(e) => setFormRoleId(e.target.value)}
            >
              <option value="">— выберите роль —</option>
              {assignableRoles.map((role) => (
                <option key={role.id} value={role.id}>
                  {role.name}
                </option>
              ))}
            </Select>
          </FieldRow>
          <FieldRow label="ID роли Discord" htmlFor={discordRoleInputId}>
            <TextInput
              id={discordRoleInputId}
              value={formDiscordRoleId}
              onChange={(e) => setFormDiscordRoleId(e.target.value)}
              placeholder="700000000000000001"
              className="font-mono"
            />
          </FieldRow>
        </div>

        <Button
          variant="primary"
          onClick={() => void create()}
          disabled={busy || formRoleId === '' || formDiscordRoleId.trim() === ''}
        >
          Добавить
        </Button>
      </CardBody>
    </Card>
  );
}
