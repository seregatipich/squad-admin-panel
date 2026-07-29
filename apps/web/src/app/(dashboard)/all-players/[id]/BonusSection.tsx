'use client';

import { useCallback, useEffect, useState } from 'react';

import {
  BONUS_TYPE_OPTIONS,
  type BonusFilters,
  type BonusPage,
  type BonusTransaction,
  buildBonusQuery,
  canAfford,
  EMPTY_BONUS_FILTERS,
  formatAmount,
  formatBonusTs,
  isCredit,
  mergeBonusPage,
  prependTransaction,
  purchaseErrorText,
  type ShopTier,
  sourceLabel,
  typeLabel,
  validateAdjust,
} from './bonus-history';

interface AdjustResponse {
  player_id: string;
  balance: number;
  transaction: BonusTransaction;
}

interface PurchaseResponse {
  ok: boolean;
  balance: number;
  role_id: string;
  role_expires_at: string;
}

export function BonusSection({ playerId }: { playerId: string }) {
  const [balance, setBalance] = useState<number | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [canAssign, setCanAssign] = useState(false);
  const [purchaseOpen, setPurchaseOpen] = useState(false);
  const [filters, setFilters] = useState<BonusFilters>(EMPTY_BONUS_FILTERS);
  const [applied, setApplied] = useState<BonusFilters>(EMPTY_BONUS_FILTERS);
  const [transactions, setTransactions] = useState<BonusTransaction[]>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  const loadBalance = useCallback(async () => {
    const res = await fetch(`/api/v1/players/${playerId}/bonus-balance`, {
      credentials: 'include',
      cache: 'no-store',
    });
    if (res.ok) setBalance(((await res.json()) as { balance: number }).balance);
  }, [playerId]);

  useEffect(() => {
    void loadBalance();
    fetch('/api/v1/me', { credentials: 'include', cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { can_manage_economy?: boolean; permissions?: string[] } | null) => {
        setCanManage(body?.can_manage_economy ?? false);
        setCanAssign(body?.permissions?.includes('user:manage_roles') ?? false);
      })
      .catch(() => {});
  }, [loadBalance]);

  const load = useCallback(
    async (next: BonusFilters) => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/v1/players/${playerId}/bonus-transactions${buildBonusQuery(next)}`,
          { credentials: 'include', cache: 'no-store' },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const page = (await res.json()) as BonusPage;
        setTransactions(mergeBonusPage([], page.items, false));
        setNextCursor(page.next_cursor);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [playerId],
  );

  useEffect(() => {
    setApplied(EMPTY_BONUS_FILTERS);
    setFilters(EMPTY_BONUS_FILTERS);
    void load(EMPTY_BONUS_FILTERS);
  }, [load]);

  async function loadMore() {
    if (nextCursor == null || busy) return;
    setBusy(true);
    try {
      const res = await fetch(
        `/api/v1/players/${playerId}/bonus-transactions${buildBonusQuery(applied, nextCursor)}`,
        { credentials: 'include', cache: 'no-store' },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const page = (await res.json()) as BonusPage;
      setTransactions((prev) => mergeBonusPage(prev, page.items, true));
      setNextCursor(page.next_cursor);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function applyFilters() {
    setApplied(filters);
    void load(filters);
  }

  function resetFilters() {
    setFilters(EMPTY_BONUS_FILTERS);
    setApplied(EMPTY_BONUS_FILTERS);
    void load(EMPTY_BONUS_FILTERS);
  }

  function onAdjusted(result: AdjustResponse) {
    setBalance(result.balance);
    setTransactions((prev) => prependTransaction(prev, result.transaction));
    setModalOpen(false);
  }

  function onPurchased(result: PurchaseResponse) {
    setBalance(result.balance);
    setPurchaseOpen(false);
    // The purchase response carries no ledger row — refresh the history so the
    // spend transaction appears.
    void load(applied);
  }

  function setField<K extends keyof BonusFilters>(key: K, value: BonusFilters[K]) {
    setFilters((prev) => ({ ...prev, [key]: value }));
  }

  return (
    <section className="rounded border border-neutral-800 bg-neutral-950 p-4 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-xs uppercase tracking-widest text-neutral-400">Бонусы</h2>
          <span className="rounded-full bg-amber-950/60 px-3 py-0.5 font-mono text-sm text-amber-200 tabular-nums">
            {balance ?? '—'}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canManage && canAssign ? (
            <button
              type="button"
              onClick={() => setPurchaseOpen(true)}
              className="rounded bg-amber-600 px-3 py-1.5 text-sm text-white hover:bg-amber-500"
            >
              Купить привилегию
            </button>
          ) : null}
          {canManage ? (
            <button
              type="button"
              onClick={() => setModalOpen(true)}
              className="rounded bg-sky-600 px-3 py-1.5 text-sm text-white hover:bg-sky-500"
            >
              Корректировать баланс
            </button>
          ) : null}
        </div>
      </div>

      <div className="border-t border-neutral-900 pt-3">
        <h3 className="mb-2 text-xs uppercase tracking-widest text-neutral-500">История бонусов</h3>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <label className="flex flex-col gap-1 text-xs text-neutral-500">
            Тип
            <select
              value={filters.type}
              onChange={(e) => setField('type', e.target.value)}
              className="rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-100"
            >
              <option value="">Любой</option>
              {BONUS_TYPE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs text-neutral-500">
            С даты
            <input
              type="date"
              value={filters.from}
              onChange={(e) => setField('from', e.target.value)}
              className="rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-100"
            />
          </label>

          <label className="flex flex-col gap-1 text-xs text-neutral-500">
            По дату
            <input
              type="date"
              value={filters.to}
              onChange={(e) => setField('to', e.target.value)}
              className="rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-100"
            />
          </label>
        </div>

        <div className="mt-2 flex gap-2">
          <button
            type="button"
            onClick={applyFilters}
            className="rounded bg-sky-600 px-4 py-1.5 text-sm text-white hover:bg-sky-500"
          >
            Применить
          </button>
          <button
            type="button"
            onClick={resetFilters}
            className="rounded border border-neutral-800 px-4 py-1.5 text-sm hover:border-neutral-600"
          >
            Сбросить
          </button>
        </div>
      </div>

      {error ? (
        <div className="rounded border border-red-900 bg-red-950 p-2 text-xs text-red-200">
          Ошибка: {error}
        </div>
      ) : null}

      {loading ? (
        <div className="text-sm text-neutral-500">Загрузка…</div>
      ) : transactions.length === 0 ? (
        <div className="rounded border border-dashed border-neutral-800 p-6 text-center text-sm text-neutral-500">
          Нет операций
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead className="text-xs uppercase tracking-widest text-neutral-500">
              <tr>
                <th className="p-1 text-left">Дата</th>
                <th className="p-1 text-left">Тип</th>
                <th className="p-1 text-right">Сумма</th>
                <th className="p-1 text-left">Источник</th>
                <th className="p-1 text-left">Комментарий</th>
              </tr>
            </thead>
            <tbody>
              {transactions.map((tx) => (
                <tr key={tx.id} className="border-t border-neutral-900 align-top">
                  <td className="whitespace-nowrap p-1 font-mono text-neutral-400">
                    {formatBonusTs(tx.created_at)}
                  </td>
                  <td className="p-1">
                    <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[11px] text-neutral-200">
                      {typeLabel(tx.type)}
                    </span>
                  </td>
                  <td
                    className={`p-1 text-right font-mono tabular-nums ${
                      tx.amount > 0 ? 'text-emerald-300' : 'text-red-300'
                    }`}
                  >
                    {formatAmount(tx.amount)}
                  </td>
                  <td className="p-1 text-neutral-400">{sourceLabel(tx)}</td>
                  <td className="p-1 text-neutral-100">
                    <span className="whitespace-pre-wrap break-words">{tx.comment ?? '—'}</span>
                    {!isCredit(tx.type) && tx.actor_player_id ? (
                      <span className="ml-2 rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] uppercase text-neutral-400">
                        админ
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {nextCursor != null ? (
        <div className="flex justify-center">
          <button
            type="button"
            onClick={() => void loadMore()}
            disabled={busy}
            className="rounded border border-neutral-800 px-3 py-1 text-xs hover:border-neutral-600 disabled:opacity-40"
          >
            Показать ещё
          </button>
        </div>
      ) : null}

      {modalOpen ? (
        <AdjustModal
          playerId={playerId}
          onClose={() => setModalOpen(false)}
          onAdjusted={onAdjusted}
        />
      ) : null}

      {purchaseOpen ? (
        <PurchaseModal
          playerId={playerId}
          balance={balance}
          onClose={() => setPurchaseOpen(false)}
          onPurchased={onPurchased}
        />
      ) : null}
    </section>
  );
}

function PurchaseModal({
  playerId,
  balance,
  onClose,
  onPurchased,
}: {
  playerId: string;
  balance: number | null;
  onClose: () => void;
  onPurchased: (result: PurchaseResponse) => void;
}) {
  const [tiers, setTiers] = useState<ShopTier[]>([]);
  const [tierId, setTierId] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/v1/bonus-shop/tiers', { credentials: 'include', cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((body: { tiers: ShopTier[] }) => setTiers(body.tiers))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const selected = tiers.find((tier) => tier.id === tierId) ?? null;
  const affordable = canAfford(balance, selected?.price_bonuses);

  async function submit() {
    if (!selected) {
      setError('Выберите привилегию.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/players/${playerId}/bonus-purchases`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tier_id: selected.id }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(purchaseErrorText(body?.error ?? `HTTP ${res.status}`));
        return;
      }
      onPurchased((await res.json()) as PurchaseResponse);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Купить привилегию"
    >
      <div className="w-full max-w-md space-y-4 rounded border border-neutral-800 bg-neutral-950 p-5">
        <h3 className="text-sm font-semibold text-neutral-100">Купить привилегию</h3>
        <p className="text-xs text-neutral-500">
          Покупка списывает бонусы, выдаёт роль привилегии на её срок и попадает в журнал аудита.
          Повторная покупка той же привилегии продлевает срок.
        </p>

        {loading ? (
          <div className="text-sm text-neutral-500">Загрузка…</div>
        ) : tiers.length === 0 ? (
          <div className="rounded border border-dashed border-neutral-800 p-4 text-center text-sm text-neutral-500">
            Нет доступных привилегий
          </div>
        ) : (
          <label className="flex flex-col gap-1 text-xs text-neutral-500">
            Привилегия
            <select
              value={tierId}
              onChange={(e) => setTierId(e.target.value)}
              className="rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-100"
            >
              <option value="">— выберите —</option>
              {tiers.map((tier) => (
                <option key={tier.id} value={tier.id}>
                  {tier.name} — {tier.price_bonuses} бонусов / {tier.default_days} дн.
                </option>
              ))}
            </select>
          </label>
        )}

        {selected ? (
          <div className="space-y-1 rounded border border-neutral-800 p-3 text-xs text-neutral-400">
            <div className="flex justify-between">
              <span>Цена</span>
              <span className="font-mono text-neutral-100 tabular-nums">
                {selected.price_bonuses}
              </span>
            </div>
            <div className="flex justify-between">
              <span>Баланс</span>
              <span className="font-mono text-neutral-100 tabular-nums">{balance ?? '—'}</span>
            </div>
            <div className="flex justify-between">
              <span>Останется</span>
              <span
                className={`font-mono tabular-nums ${affordable ? 'text-emerald-300' : 'text-red-300'}`}
              >
                {balance != null && selected.price_bonuses != null
                  ? balance - selected.price_bonuses
                  : '—'}
              </span>
            </div>
            {!affordable ? (
              <div className="text-red-300">Недостаточно бонусов для покупки.</div>
            ) : null}
          </div>
        ) : null}

        {error ? (
          <div className="rounded border border-red-900 bg-red-950 p-2 text-xs text-red-200">
            {error}
          </div>
        ) : null}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded border border-neutral-800 px-4 py-2 text-sm hover:border-neutral-600 disabled:opacity-40"
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy || !selected || !affordable}
            className="rounded bg-amber-600 px-4 py-2 text-sm text-white hover:bg-amber-500 disabled:opacity-40"
          >
            Купить
          </button>
        </div>
      </div>
    </div>
  );
}

function AdjustModal({
  playerId,
  onClose,
  onAdjusted,
}: {
  playerId: string;
  onClose: () => void;
  onAdjusted: (result: AdjustResponse) => void;
}) {
  const [amount, setAmount] = useState('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const parsed = validateAdjust(amount, comment);
    if (typeof parsed === 'string') {
      setError(parsed);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/players/${playerId}/bonus-adjustments`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(parsed),
      });
      if (res.status === 403) {
        setError('Недостаточно прав: требуется can_manage_economy.');
        return;
      }
      if (res.status === 409) {
        setError('Баланс не может стать отрицательным.');
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      onAdjusted((await res.json()) as AdjustResponse);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Корректировать баланс"
    >
      <div className="w-full max-w-md space-y-4 rounded border border-neutral-800 bg-neutral-950 p-5">
        <h3 className="text-sm font-semibold text-neutral-100">Корректировать баланс</h3>
        <p className="text-xs text-neutral-500">
          Положительная сумма начисляет бонусы, отрицательная — списывает. Комментарий обязателен и
          попадёт в журнал аудита.
        </p>

        <label className="flex flex-col gap-1 text-xs text-neutral-500">
          Сумма (±)
          <input
            type="number"
            step={1}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="например, -50"
            className="rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs text-neutral-500">
          Комментарий
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={3}
            maxLength={512}
            placeholder="причина корректировки"
            className="rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100"
          />
        </label>

        {error ? (
          <div className="rounded border border-red-900 bg-red-950 p-2 text-xs text-red-200">
            {error}
          </div>
        ) : null}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded border border-neutral-800 px-4 py-2 text-sm hover:border-neutral-600 disabled:opacity-40"
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy}
            className="rounded bg-sky-600 px-4 py-2 text-sm text-white hover:bg-sky-500 disabled:opacity-40"
          >
            Применить
          </button>
        </div>
      </div>
    </div>
  );
}
