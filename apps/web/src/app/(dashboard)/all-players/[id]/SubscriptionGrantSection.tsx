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

interface Subscription {
  id: string;
  tier_id: string;
  tier_name?: string;
  status: string;
  renews_every_days: number;
  price_bonuses: number;
  next_renewal_at: string;
  created_at: string;
}

interface ShopTier {
  id: string;
  name: string;
  default_days: number | null;
  price_bonuses: number | null;
}

const STATUS_LABELS: Record<string, string> = {
  active: 'Активна',
  cancelled: 'Отменена',
  expired: 'Истекла',
};

/** Состояние подписки, а не категория: тон дублирует подпись, а не заменяет её (§5). */
const STATUS_TONE: Record<string, BadgeTone> = {
  active: 'good',
  cancelled: 'neutral',
  expired: 'warn',
};

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}`;
}

/**
 * VIPSUB-5 (#171): grant or review a player's VIP subscription from the player
 * card. Self-hides on 401/403 rather than reading a capability flag — the
 * batch freezes `GET /api/v1/me`, and the route requires `can_manage_economy`
 * together with `can_assign_roles` (it both spends the ledger and grants a
 * role, mirroring the ECON-6 privilege-shop guard).
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
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
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
      if (tiersRes.ok) {
        const body = (await tiersRes.json()) as { tiers: ShopTier[] };
        const purchasable = body.tiers.filter((t) => t.price_bonuses != null);
        setTiers(purchasable);
        setCanGrant(purchasable.length > 0);
        setSelected((prev) => prev || (purchasable[0]?.id ?? ''));
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [playerId]);

  useEffect(() => {
    void load();
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
        setError(body?.error ?? `HTTP ${res.status}`);
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

        {loading ? (
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
                    <Badge size="sm" tone={STATUS_TONE[row.status] ?? 'neutral'}>
                      {STATUS_LABELS[row.status] ?? row.status}
                    </Badge>
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

      {canGrant ? (
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
