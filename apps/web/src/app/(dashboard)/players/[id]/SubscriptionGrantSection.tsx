'use client';

import { useCallback, useEffect, useState } from 'react';

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
    <section className="rounded border border-neutral-800 bg-neutral-950 p-4 space-y-3">
      <h2 className="text-xs uppercase tracking-widest text-neutral-400">VIP-подписка</h2>

      {error ? (
        <div className="rounded border border-red-900 bg-red-950 p-3 text-sm text-red-200">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="rounded border border-emerald-900 bg-emerald-950 p-3 text-sm text-emerald-200">
          {notice}
        </div>
      ) : null}

      {loading ? (
        <div className="py-4 text-center text-sm text-neutral-500">Загрузка…</div>
      ) : rows.length === 0 ? (
        <p className="text-sm text-neutral-500">Подписок нет.</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {rows.map((row) => (
            <li key={row.id} className="border-t border-neutral-900 pt-1 text-neutral-300">
              {row.tier_name ?? row.tier_id} — {STATUS_LABELS[row.status] ?? row.status},{' '}
              {row.price_bonuses} бонусов / {row.renews_every_days} дн., следующее списание{' '}
              {formatDate(row.next_renewal_at)}
            </li>
          ))}
        </ul>
      )}

      {canGrant ? (
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-xs text-neutral-500" htmlFor="subscription-tier">
            Тариф
          </label>
          <select
            id="subscription-tier"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm text-neutral-200"
          >
            {tiers.map((tier) => (
              <option key={tier.id} value={tier.id}>
                {tier.name} — {tier.price_bonuses} / {tier.default_days} дн.
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={busy || !selected}
            onClick={() => void grant()}
            className="rounded border border-emerald-800 px-3 py-1 text-sm text-emerald-200 disabled:opacity-50"
          >
            Выдать подписку
          </button>
        </div>
      ) : null}
    </section>
  );
}
