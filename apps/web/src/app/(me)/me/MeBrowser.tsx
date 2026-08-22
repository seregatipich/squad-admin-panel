'use client';

import { useCallback, useEffect, useState } from 'react';

import {
  AlertDialog,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  GroupedRow,
  InlineBanner,
  PageContainer,
  PageHeader,
  Skeleton,
  StatTile,
  Table,
  TableBody,
  TableHead,
  TableRow,
  Td,
  Th,
} from '@/components/ui';
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
  /* Подписка, отмену которой оператор запросил, но ещё не подтвердил. Хранится
     сама строка, а не флаг: диалог продолжает называть тариф даже в тот момент,
     когда перезагруженный список уже не считает подписку активной. */
  const [cancelTarget, setCancelTarget] = useState<MeSubscription | null>(null);

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

  /* Отмена не разрушает данные: оплаченный период остаётся, подписку можно
     оформить заново — поэтому подтверждение обычное, а не критическое (§5). */
  async function confirmCancel(): Promise<void> {
    if (!cancelTarget) return;
    await mutate(
      () =>
        fetch(`/api/v1/me/subscriptions/${cancelTarget.id}`, {
          method: 'DELETE',
          credentials: 'include',
        }),
      'Подписка отменена. Оплаченный период сохранён.',
    );
    setCancelTarget(null);
  }

  const current = activeSubscription(subscriptions);
  const vipDaysLeft = daysUntil(balance?.role_expires_at ?? null);
  const firstLoad = loading && balance === null;

  return (
    <PageContainer width="reading">
      <PageHeader title="Мой VIP" subtitle={displayName} />

      {error ? (
        <InlineBanner
          tone="crit"
          title={error}
          action={
            <Button size="sm" onClick={() => void load()} disabled={busy}>
              Повторить
            </Button>
          }
        />
      ) : null}
      {notice ? <InlineBanner tone="good" title={notice} /> : null}

      {firstLoad ? (
        <div className="space-y-6">
          <Skeleton variant="card" label="Загружаем данные вашего VIP" />
          <Skeleton variant="card" count={2} />
        </div>
      ) : (
        <>
          <StatTile
            label="Баланс"
            value={balance?.balance ?? 0}
            hint={
              balance?.role_expires_at
                ? `VIP активен до ${formatDateTime(balance.role_expires_at)} (осталось ${vipDaysLeft} дн.)`
                : 'VIP сейчас не активен.'
            }
          />

          <Card padding="none">
            <CardHeader title="Подписка" />
            <CardBody className="space-y-3">
              {current ? (
                <div className="space-y-2">
                  <p className="text-[13px] text-ink">
                    {current.tier_name ?? 'Тариф'} — {current.price_bonuses} бонусов каждые{' '}
                    {current.renews_every_days} дн.
                  </p>
                  <p className="text-xs text-ink-3">
                    Следующее списание: {formatDateTime(current.next_renewal_at)}
                  </p>
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => setCancelTarget(current)}
                  >
                    Отменить подписку
                  </Button>
                </div>
              ) : (
                <p className="text-xs text-ink-3">Активной подписки нет.</p>
              )}

              {subscriptions.length > 0 ? (
                <ul className="space-y-1 text-xs text-ink-3">
                  {subscriptions.map((row) => (
                    <li key={row.id}>
                      {row.tier_name ?? row.tier_id} — {subscriptionStatusLabel(row.status)} (с{' '}
                      {formatDateTime(row.created_at)})
                    </li>
                  ))}
                </ul>
              ) : null}
            </CardBody>
          </Card>

          <Card padding="none">
            <CardHeader title="Тарифы" count={tiers.length > 0 ? tiers.length : undefined} />
            {tiers.length === 0 ? (
              <EmptyState
                title="Тарифы сейчас недоступны."
                description="Продажа VIP закрыта администрацией. Загляните позже."
              />
            ) : (
              <div className="divide-y divide-line">
                {tiers.map((tier) => (
                  <GroupedRow
                    key={tier.tier_id}
                    label={tier.name}
                    description={`${tier.price_bonuses} бонусов за ${tier.days} дн.${
                      tier.description ? ` — ${tier.description}` : ''
                    }`}
                    control={
                      <>
                        <Button size="sm" disabled={busy} onClick={() => buy(tier.tier_id)}>
                          Купить разово
                        </Button>
                        <Button
                          size="sm"
                          variant="primary"
                          disabled={busy || current !== null}
                          onClick={() => subscribe(tier.tier_id)}
                        >
                          Подписаться
                        </Button>
                      </>
                    }
                  />
                ))}
              </div>
            )}
          </Card>

          <Card padding="none">
            <CardHeader title="История бонусов" />
            {history.length === 0 ? (
              <EmptyState
                title="Операций пока нет."
                description="Здесь появятся начисления за онлайн и списания за VIP."
              />
            ) : (
              <Table ariaLabel="История начислений и списаний бонусов">
                <TableHead sticky={false}>
                  <TableRow>
                    <Th>Дата</Th>
                    <Th>Тип</Th>
                    <Th align="right">Сумма</Th>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {history.map((row) => (
                    <TableRow key={row.id}>
                      <Td>{formatDateTime(row.created_at)}</Td>
                      <Td>{bonusTypeLabel(row.type)}</Td>
                      {/* Знак «+»/«−» уже несёт смысл сам по себе: цвет здесь
                          дублирует его, а не заменяет (§5). */}
                      <Td numeric className={row.amount >= 0 ? 'text-good' : 'text-crit'}>
                        {formatAmount(row.amount)}
                      </Td>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            {cursor !== null ? (
              <div className="border-t border-line px-4 py-3">
                <Button onClick={() => void loadMore()} loading={busy}>
                  Показать ещё
                </Button>
              </div>
            ) : null}
          </Card>
        </>
      )}

      <AlertDialog
        open={cancelTarget !== null}
        onClose={() => setCancelTarget(null)}
        title="Отменить подписку?"
        body={
          cancelTarget
            ? `Списания за «${cancelTarget.tier_name ?? 'тариф'}» прекратятся. Оплаченный период сохранится — VIP будет действовать до ${formatDateTime(cancelTarget.next_renewal_at)}.`
            : ''
        }
        confirmLabel="Отменить подписку"
        cancelLabel="Оставить подписку"
        tone="default"
        busy={busy}
        onConfirm={() => void confirmCancel()}
      />
    </PageContainer>
  );
}
