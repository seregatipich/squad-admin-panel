'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import {
  Badge,
  type BadgeTone,
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  EmptyState,
  InlineBanner,
  Select,
  Skeleton,
  Table,
  TableBody,
  TableHead,
  TableRow,
  Td,
  Th,
} from '@/components/ui';
import { purchaseErrorText, type ShopTier } from './bonus-history';

/** `vip_subscriptions.status` — the closed set the API writes. */
type SubscriptionStatus = 'active' | 'cancelled' | 'expired';

interface Subscription {
  id: string;
  tier_id: string;
  tier_name?: string;
  /** A {@link SubscriptionStatus}; typed wide so a newer API value still renders. */
  status: string;
  renews_every_days: number;
  price_bonuses: number;
  next_renewal_at: string;
  created_at: string;
}

const STATUS_LABELS: Record<SubscriptionStatus, string> = {
  active: 'Активна',
  cancelled: 'Отменена',
  expired: 'Истекла',
};

/** Состояние подписки, а не категория: тон дублирует подпись, а не заменяет её (§5). */
const STATUS_TONE: Record<SubscriptionStatus, BadgeTone> = {
  active: 'good',
  cancelled: 'neutral',
  expired: 'warn',
};

function isSubscriptionStatus(status: string): status is SubscriptionStatus {
  return Object.hasOwn(STATUS_LABELS, status);
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}`;
}

/**
 * VIPSUB-5 (#171): grant or review a player's VIP subscription from the player
 * card. The list itself self-hides on 401/403 (both GET endpoints only require
 * `panel_access`, so any panel user can view them). The grant footer is a
 * separate concern: `POST .../subscriptions` requires `can_manage_economy`
 * together with `can_assign_roles` (it both spends the ledger and grants a
 * role, mirroring the ECON-6 privilege-shop guard), so `canGrant` is derived
 * from those two flags on `/api/v1/me` — not from whether any tier happens to
 * be purchasable (#459).
 *
 * A failed read and a refused grant are separate states: the first offers
 * «Повторить», the second is translated through `purchaseErrorText` (#460).
 */
export function SubscriptionGrantSection({ playerId }: { playerId: string }) {
  const tierSelectId = useId();
  const [rows, setRows] = useState<Subscription[]>([]);
  const [tiers, setTiers] = useState<ShopTier[]>([]);
  const [selected, setSelected] = useState('');
  const [hidden, setHidden] = useState(false);
  const [canGrant, setCanGrant] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tiersError, setTiersError] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch(`/api/v1/players/${playerId}/subscriptions`, {
        credentials: 'include',
        cache: 'no-store',
      });
      if (res.status === 401 || res.status === 403) {
        setHidden(true);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setRows(((await res.json()) as { rows: Subscription[] }).rows);

      const tiersRes = await fetch('/api/v1/bonus-shop/tiers', {
        credentials: 'include',
        cache: 'no-store',
      });
      setTiersError(!tiersRes.ok);
      if (tiersRes.ok) {
        const body = (await tiersRes.json()) as { tiers: ShopTier[] };
        const purchasable = body.tiers.filter((t) => t.price_bonuses != null);
        setTiers(purchasable);
        setSelected((prev) => prev || (purchasable[0]?.id ?? ''));
      }
    } catch (err) {
      setLoadError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [playerId]);

  useEffect(() => {
    void load();
    fetch('/api/v1/me', { credentials: 'include', cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { can_manage_economy?: boolean; permissions?: string[] } | null) => {
        setCanGrant(
          (body?.can_manage_economy ?? false) &&
            (body?.permissions?.includes('user:manage_roles') ?? false),
        );
      })
      .catch(() => {});
  }, [load]);

  async function grant(): Promise<void> {
    if (!selected) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/v1/players/${playerId}/subscriptions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ tier_id: selected }),
      });
      if (res.status === 403) {
        const body = (await res.json().catch(() => null)) as { required?: string } | null;
        setError(
          body?.required
            ? `Недостаточно прав: требуется ${body.required}.`
            : 'Недостаточно прав для выдачи подписки.',
        );
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ? purchaseErrorText(body.error) : `HTTP ${res.status}`);
        return;
      }
      setNotice('Подписка выдана: первый период списан с баланса игрока.');
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (hidden) return null;

  return (
    <Card padding="none" as="section">
      <CardHeader title="VIP-подписка" />
      <CardBody className="space-y-3">
        {error ? <InlineBanner tone="crit" title="Подписка не выдана" description={error} /> : null}
        {notice ? <InlineBanner tone="good" title={notice} /> : null}
        {tiersError ? (
          <InlineBanner
            tone="warn"
            title="Не удалось загрузить тарифы"
            description="Выдача подписки недоступна, пока список тарифов не загрузится."
          />
        ) : null}

        {loadError ? (
          <InlineBanner
            tone="crit"
            title="Не удалось загрузить подписки"
            description={loadError}
            action={
              <Button size="sm" onClick={() => void load()}>
                Повторить
              </Button>
            }
          />
        ) : loading ? (
          <Skeleton variant="row" count={2} label="Загрузка подписок" />
        ) : rows.length === 0 ? (
          <EmptyState
            title="Подписок нет"
            description="Игроку ещё не выдавали VIP-подписку через панель."
          />
        ) : (
          <Table ariaLabel="Подписки игрока">
            <TableHead>
              <TableRow>
                <Th>Тариф</Th>
                <Th>Статус</Th>
                <Th align="right">Цена</Th>
                <Th align="right">Период</Th>
                <Th align="right">Следующее списание</Th>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <Td>{row.tier_name ?? row.tier_id}</Td>
                  <Td>
                    {isSubscriptionStatus(row.status) ? (
                      <Badge size="sm" tone={STATUS_TONE[row.status]}>
                        {STATUS_LABELS[row.status]}
                      </Badge>
                    ) : (
                      <Badge size="sm">{row.status}</Badge>
                    )}
                  </Td>
                  <Td numeric>{row.price_bonuses} бон.</Td>
                  <Td numeric>{row.renews_every_days} дн.</Td>
                  <Td numeric>{formatDate(row.next_renewal_at)}</Td>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardBody>

      {canGrant && tiers.length > 0 ? (
        <CardFooter className="justify-between">
          <label className="text-xs text-ink-2" htmlFor={tierSelectId}>
            Тариф
          </label>
          <div className="flex items-center gap-2">
            <Select
              id={tierSelectId}
              size="sm"
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
            >
              {tiers.map((tier) => (
                <option key={tier.id} value={tier.id}>
                  {tier.name} — {tier.price_bonuses} / {tier.default_days} дн.
                </option>
              ))}
            </Select>
            <Button
              variant="primary"
              size="sm"
              loading={busy}
              disabled={!selected}
              onClick={() => void grant()}
            >
              Выдать подписку
            </Button>
          </div>
        </CardFooter>
      ) : null}
    </Card>
  );
}
