'use client';

import { useCallback, useEffect, useState } from 'react';

import {
  activeSubscription,
  bonusTypeLabel,
  daysUntil,
  errorMessage,
  formatAmount,
  formatDateTime,
  type MeBalance,
  type MeBonusPage,
  type MeBonusTransaction,
  type MeSubscription,
  type MeTier,
  mergeBonusPage,
  subscriptionStatusLabel,
} from './me-vip';

const HISTORY_PAGE_SIZE = 20;

const json = { 'content-type': 'application/json' };

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return errorMessage(body?.error);
  } catch {
    return errorMessage(null);
  }
}

/**
 * VIPSUB-5 (#171) self-service page for a logged-in player.
 *
 * Every request goes to `/api/v1/me/*`, which take no player id at all — the
 * subject is the session's own player — so this page structurally cannot show
 * or touch anybody else's data. It is reachable by a session with no panel
 * access, which is why it does not reuse any `(dashboard)` section.
 */
export function MeBrowser({ displayName }: { displayName: string }) {
  const [balance, setBalance] = useState<MeBalance | null>(null);
  const [tiers, setTiers] = useState<MeTier[]>([]);
  const [subscriptions, setSubscriptions] = useState<MeSubscription[]>([]);
  const [history, setHistory] = useState<MeBonusTransaction[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [balanceRes, tiersRes, subsRes, historyRes] = await Promise.all([
        fetch('/api/v1/me/bonus-balance', { credentials: 'include', cache: 'no-store' }),
        fetch('/api/v1/me/tiers', { credentials: 'include', cache: 'no-store' }),
        fetch('/api/v1/me/subscriptions', { credentials: 'include', cache: 'no-store' }),
        fetch(`/api/v1/me/bonus-transactions?limit=${HISTORY_PAGE_SIZE}`, {
          credentials: 'include',
          cache: 'no-store',
        }),
      ]);
      if (!balanceRes.ok) throw new Error(await readError(balanceRes));
      if (!tiersRes.ok) throw new Error(await readError(tiersRes));
      if (!subsRes.ok) throw new Error(await readError(subsRes));
      if (!historyRes.ok) throw new Error(await readError(historyRes));

      setBalance((await balanceRes.json()) as MeBalance);
      setTiers(((await tiersRes.json()) as { rows: MeTier[] }).rows);
      setSubscriptions(((await subsRes.json()) as { rows: MeSubscription[] }).rows);
      const page = (await historyRes.json()) as MeBonusPage;
      setHistory(page.items);
      setCursor(page.next_cursor);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function loadMore(): Promise<void> {
    if (cursor === null) return;
    setBusy(true);
    try {
      const res = await fetch(
        `/api/v1/me/bonus-transactions?limit=${HISTORY_PAGE_SIZE}&before=${cursor}`,
        { credentials: 'include', cache: 'no-store' },
      );
      if (!res.ok) throw new Error(await readError(res));
      const page = (await res.json()) as MeBonusPage;
      setHistory((prev) => mergeBonusPage(prev, page.items));
      setCursor(page.next_cursor);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function mutate(request: () => Promise<Response>, successMessage: string): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await request();
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      setNotice(successMessage);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const buy = (tierId: string) =>
    mutate(
      () =>
        fetch('/api/v1/me/purchases', {
          method: 'POST',
          headers: json,
          credentials: 'include',
          body: JSON.stringify({ tier_id: tierId }),
        }),
      'VIP продлён.',
    );

  const subscribe = (tierId: string) =>
    mutate(
      () =>
        fetch('/api/v1/me/subscriptions', {
          method: 'POST',
          headers: json,
          credentials: 'include',
          body: JSON.stringify({ tier_id: tierId }),
        }),
      'Подписка оформлена.',
    );

  const cancel = (subscriptionId: string) => {
    if (!confirm('Отменить подписку? Оплаченный период сохранится.')) return;
    return mutate(
      () =>
        fetch(`/api/v1/me/subscriptions/${subscriptionId}`, {
          method: 'DELETE',
          credentials: 'include',
        }),
      'Подписка отменена. Оплаченный период сохранён.',
    );
  };

  const current = activeSubscription(subscriptions);
  const vipDaysLeft = daysUntil(balance?.role_expires_at ?? null);

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold text-neutral-100">Мой VIP</h1>
        <p className="text-sm text-neutral-400">{displayName}</p>
      </header>

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

      {loading && !balance ? (
        <div className="py-6 text-center text-sm text-neutral-500">Загрузка…</div>
      ) : null}

      <section className="rounded border border-neutral-800 bg-neutral-950 p-4 space-y-2">
        <h2 className="text-xs uppercase tracking-widest text-neutral-400">Баланс</h2>
        <div className="font-mono text-3xl text-emerald-300">{balance?.balance ?? 0}</div>
        <p className="text-sm text-neutral-400">
          {balance?.role_expires_at
            ? `VIP активен до ${formatDateTime(balance.role_expires_at)} (осталось ${vipDaysLeft} дн.)`
            : 'VIP сейчас не активен.'}
        </p>
      </section>

      <section className="rounded border border-neutral-800 bg-neutral-950 p-4 space-y-3">
        <h2 className="text-xs uppercase tracking-widest text-neutral-400">Подписка</h2>
        {current ? (
          <div className="space-y-2">
            <p className="text-sm text-neutral-200">
              {current.tier_name ?? 'Тариф'} — {current.price_bonuses} бонусов каждые{' '}
              {current.renews_every_days} дн.
            </p>
            <p className="text-sm text-neutral-400">
              Следующее списание: {formatDateTime(current.next_renewal_at)}
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={() => cancel(current.id)}
              className="rounded border border-red-900 px-3 py-1 text-sm text-red-200 disabled:opacity-50"
            >
              Отменить подписку
            </button>
          </div>
        ) : (
          <p className="text-sm text-neutral-500">Активной подписки нет.</p>
        )}

        {subscriptions.length > 0 ? (
          <ul className="space-y-1 text-xs text-neutral-500">
            {subscriptions.map((row) => (
              <li key={row.id}>
                {row.tier_name ?? row.tier_id} — {subscriptionStatusLabel(row.status)} (с{' '}
                {formatDateTime(row.created_at)})
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="rounded border border-neutral-800 bg-neutral-950 p-4 space-y-3">
        <h2 className="text-xs uppercase tracking-widest text-neutral-400">Тарифы</h2>
        {tiers.length === 0 ? (
          <p className="text-sm text-neutral-500">Тарифы сейчас недоступны.</p>
        ) : (
          <ul className="space-y-2">
            {tiers.map((tier) => (
              <li
                key={tier.tier_id}
                className="flex flex-wrap items-center justify-between gap-2 rounded border border-neutral-800 bg-neutral-900/40 p-3"
              >
                <div>
                  <div className="text-sm text-neutral-100">{tier.name}</div>
                  <div className="text-xs text-neutral-500">
                    {tier.price_bonuses} бонусов за {tier.days} дн.
                    {tier.description ? ` — ${tier.description}` : ''}
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => buy(tier.tier_id)}
                    className="rounded border border-neutral-700 px-3 py-1 text-sm text-neutral-200 disabled:opacity-50"
                  >
                    Купить разово
                  </button>
                  <button
                    type="button"
                    disabled={busy || current !== null}
                    onClick={() => subscribe(tier.tier_id)}
                    className="rounded border border-emerald-800 px-3 py-1 text-sm text-emerald-200 disabled:opacity-50"
                  >
                    Подписаться
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded border border-neutral-800 bg-neutral-950 p-4 space-y-3">
        <h2 className="text-xs uppercase tracking-widest text-neutral-400">История бонусов</h2>
        {history.length === 0 ? (
          <p className="text-sm text-neutral-500">Операций пока нет.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[420px] text-sm">
              <thead className="text-xs uppercase tracking-widest text-neutral-500">
                <tr>
                  <th className="p-1 text-left">Дата</th>
                  <th className="p-1 text-left">Тип</th>
                  <th className="p-1 text-right">Сумма</th>
                </tr>
              </thead>
              <tbody>
                {history.map((row) => (
                  <tr key={row.id} className="border-t border-neutral-900">
                    <td className="p-1 text-neutral-400">{formatDateTime(row.created_at)}</td>
                    <td className="p-1 text-neutral-300">{bonusTypeLabel(row.type)}</td>
                    <td
                      className={`p-1 text-right font-mono ${row.amount >= 0 ? 'text-emerald-300' : 'text-red-300'}`}
                    >
                      {formatAmount(row.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {cursor !== null ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void loadMore()}
            className="rounded border border-neutral-700 px-3 py-1 text-sm text-neutral-200 disabled:opacity-50"
          >
            Показать ещё
          </button>
        ) : null}
      </section>
    </div>
  );
}
