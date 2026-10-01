import type { RoleColor } from '@squad/shared-config/role-colors';
import { cookies } from 'next/headers';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { RoleColorDot } from '@/components/RoleColorDot';
import {
  Badge,
  Button,
  ButtonLink,
  Card,
  Checkbox,
  EmptyState,
  InlineBanner,
  PageContainer,
  PageHeader,
  Select,
  Table,
  TableBody,
  TableHead,
  TableRow,
  Td,
  Th,
} from '@/components/ui';
import { apiFetch } from '@/lib/api';
import { requireSession, SESSION_COOKIE } from '@/lib/dal';
import {
  DEFAULT_VIP_EXPIRY_WINDOWS_DAYS,
  formatVipExpiry,
  isRoleExpirySoon,
} from '@/lib/role-expiry';

export const dynamic = 'force-dynamic';

interface RoleOption {
  id: string;
  name: string;
  color: RoleColor;
}

interface RoleAssignmentRow {
  id: string;
  steam_id64: string | null;
  eos_id: string | null;
  canonical_name: string;
  role: { id: string; name: string; color: RoleColor };
  role_expires_at: string | null;
  role_comment: string | null;
  last_seen_at: string;
}

interface VipsPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** Next 15 hands a repeated query key over as an array; the page uses the first value. */
function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * `/vips` — read-only registry of every player currently holding a panel
 * role (VIPSUB-2, issue #168): role badge, SteamID64/EOS identity, expiry
 * (permanent vs. a relative countdown), and the assignment comment.
 *
 * Server-rendered through `lib/dal.ts`/`lib/api.ts` against
 * `GET /api/v1/role-assignments`; the role and "expiring soon" filters are
 * plain query-string search params so the page works without client JS.
 * Поэтому фильтры собраны из примитивов, которые не требуют обработчиков:
 * форма отправляется браузером, а не React.
 */
export default async function VipsPage({ searchParams }: VipsPageProps) {
  const me = await requireSession();
  if (!me.permissions.includes('user:view')) {
    redirect('/dashboard');
  }

  const rawParams = await searchParams;
  const params = {
    role_id: firstValue(rawParams.role_id),
    expiring_soon: firstValue(rawParams.expiring_soon),
  };
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  const cookie = token ? `${SESSION_COOKIE}=${token}` : '';

  const query = new URLSearchParams();
  if (params.role_id) query.set('role_id', params.role_id);
  const expiringSoon = params.expiring_soon === 'true';
  if (expiringSoon) query.set('expiring_soon', 'true');
  const qs = query.toString();

  const [assignmentsResult, rolesResult, economyResult] = await Promise.allSettled([
    apiFetch<RoleAssignmentRow[]>(`/api/v1/role-assignments${qs ? `?${qs}` : ''}`, { cookie }),
    apiFetch<RoleOption[]>('/api/v1/roles', { cookie }),
    apiFetch<{ vip_expiry_windows_days?: number[] }>('/api/v1/settings/economy', { cookie }),
  ]);

  const loadFailed = assignmentsResult.status === 'rejected';
  const rows = assignmentsResult.status === 'fulfilled' ? assignmentsResult.value : [];
  const roleOptions = rolesResult.status === 'fulfilled' ? rolesResult.value : [];

  // Reminder windows drive the «истекает» badge (VIPSUB-4, #170); fall back
  // to the server-side default when the settings endpoint is unavailable.
  const economyWindows =
    economyResult.status === 'fulfilled' ? economyResult.value.vip_expiry_windows_days : undefined;
  const expiryWindows = Array.isArray(economyWindows)
    ? economyWindows
    : DEFAULT_VIP_EXPIRY_WINDOWS_DAYS;

  const filtersApplied = Boolean(params.role_id) || expiringSoon;

  return (
    <PageContainer>
      <PageHeader
        title="VIP-роли"
        subtitle="Реестр игроков с выданной ролью панели: срок действия, комментарий к выдаче и последний визит."
        meta={<span>Игроков: {rows.length}</span>}
      />

      <form method="GET" className="flex flex-wrap items-center gap-2">
        <label htmlFor="vips-role" className="text-xs text-ink-3">
          Роль
        </label>
        <Select id="vips-role" name="role_id" defaultValue={params.role_id ?? ''}>
          <option value="">Все роли</option>
          {roleOptions.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </Select>
        <Checkbox
          label="Истекают скоро"
          name="expiring_soon"
          value="true"
          defaultChecked={expiringSoon}
        />
        <Button type="submit" variant="primary">
          Применить
        </Button>
        {filtersApplied ? <ButtonLink href="/vips">Сбросить фильтр</ButtonLink> : null}
      </form>

      {loadFailed ? (
        <InlineBanner
          tone="crit"
          title="Не удалось загрузить реестр."
          description="Сервер не ответил или отклонил запрос. Обновите страницу или попробуйте позже."
        />
      ) : (
        <Card padding="none">
          {rows.length === 0 ? (
            <EmptyState
              variant={filtersApplied ? 'filtered' : 'initial'}
              title={filtersApplied ? 'Ничего не нашлось' : 'Ролей никому не выдано'}
              description={
                filtersApplied
                  ? 'Ни один игрок не подходит под выбранные фильтры.'
                  : 'Ни у одного игрока сейчас нет роли панели.'
              }
              action={filtersApplied ? <ButtonLink href="/vips">Сбросить фильтр</ButtonLink> : null}
            />
          ) : (
            <Table ariaLabel="Игроки с выданными ролями">
              <TableHead>
                <tr>
                  <Th>Роль</Th>
                  <Th>Игрок</Th>
                  <Th>SteamID64 / EOS ID</Th>
                  <Th>Срок</Th>
                  <Th>Комментарий</Th>
                  <Th>Был(а) (UTC)</Th>
                </tr>
              </TableHead>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id} interactive>
                    <Td className="whitespace-nowrap">
                      <span className="inline-flex items-center gap-2">
                        <RoleColorDot color={r.role.color} />
                        {r.role.name}
                      </span>
                    </Td>
                    <Td>
                      <Link
                        href={`/all-players/${r.id}`}
                        className="text-accent no-underline hover:brightness-110"
                      >
                        {r.canonical_name}
                      </Link>
                    </Td>
                    <Td className="font-mono text-xs text-ink-2">
                      {r.steam_id64 ?? r.eos_id ?? '—'}
                    </Td>
                    <Td className="whitespace-nowrap text-ink-2">
                      {formatVipExpiry(r.role_expires_at)}
                      {isRoleExpirySoon(r.role_expires_at, expiryWindows) ? (
                        <span className="ml-2">
                          <Badge tone="warn" size="sm">
                            истекает
                          </Badge>
                        </span>
                      ) : null}
                    </Td>
                    <Td className="text-ink-3">
                      {r.role_comment ? (
                        <span className="block max-w-56 truncate" title={r.role_comment}>
                          {r.role_comment}
                        </span>
                      ) : (
                        '—'
                      )}
                    </Td>
                    <Td className="whitespace-nowrap text-ink-3">
                      {new Date(r.last_seen_at).toLocaleString('ru-RU', { timeZone: 'UTC' })}
                    </Td>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>
      )}
    </PageContainer>
  );
}
