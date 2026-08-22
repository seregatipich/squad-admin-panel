'use client';

import { useCallback, useEffect, useId, useState } from 'react';

import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  FieldRow,
  InlineBanner,
  Modal,
  Select,
  SkeletonTable,
  Table,
  TableBody,
  TableHead,
  TableRow,
  Td,
  Textarea,
  TextInput,
  Th,
  Toolbar,
} from '@/components/ui';
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
  const typeFilterId = useId();
  const fromFilterId = useId();
  const toFilterId = useId();

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

  const filtersApplied = applied.type !== '' || applied.from !== '' || applied.to !== '';

  return (
    <Card as="section" padding="none">
      <CardHeader
        title="Бонусы"
        count={
          <Badge tone="warn" size="sm">
            {balance ?? '—'}
          </Badge>
        }
        actions={
          <>
            {canManage && canAssign ? (
              <Button size="sm" onClick={() => setPurchaseOpen(true)}>
                Купить привилегию
              </Button>
            ) : null}
            {canManage ? (
              <Button size="sm" variant="primary" onClick={() => setModalOpen(true)}>
                Корректировать баланс
              </Button>
            ) : null}
          </>
        }
      />

      <CardBody className="space-y-4">
        <h3 className="text-[13px] font-semibold text-ink">История бонусов</h3>

        <Toolbar
          filters={
            <>
              <label
                htmlFor={typeFilterId}
                className="flex items-center gap-1.5 text-xs text-ink-3"
              >
                Тип
                <Select
                  id={typeFilterId}
                  size="sm"
                  value={filters.type}
                  onChange={(e) => setField('type', e.target.value)}
                >
                  <option value="">Любой</option>
                  {BONUS_TYPE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </label>

              <label
                htmlFor={fromFilterId}
                className="flex items-center gap-1.5 text-xs text-ink-3"
              >
                С даты
                <TextInput
                  id={fromFilterId}
                  type="date"
                  size="sm"
                  value={filters.from}
                  onChange={(e) => setField('from', e.target.value)}
                />
              </label>

              <label htmlFor={toFilterId} className="flex items-center gap-1.5 text-xs text-ink-3">
                По дату
                <TextInput
                  id={toFilterId}
                  type="date"
                  size="sm"
                  value={filters.to}
                  onChange={(e) => setField('to', e.target.value)}
                />
              </label>
            </>
          }
          onReset={resetFilters}
          resetLabel="Сбросить"
          actions={
            <Button size="sm" variant="primary" onClick={applyFilters}>
              Применить
            </Button>
          }
        />

        {error ? (
          <InlineBanner
            tone="crit"
            title="Не удалось загрузить историю бонусов"
            description={error}
            action={
              <Button size="sm" onClick={() => void load(applied)}>
                Повторить
              </Button>
            }
          />
        ) : null}

        {loading ? (
          <SkeletonTable rows={5} cols={5} label="Загрузка истории бонусов" />
        ) : transactions.length === 0 ? (
          <EmptyState
            variant={filtersApplied ? 'filtered' : 'initial'}
            title={filtersApplied ? 'Нет операций по фильтру' : 'Операций нет'}
            description={
              filtersApplied
                ? 'Ни одна операция не подходит под выбранные тип и даты.'
                : 'Бонусы этому игроку ещё ни разу не начисляли и не списывали.'
            }
            action={
              filtersApplied ? (
                <Button size="sm" onClick={resetFilters}>
                  Сбросить фильтр
                </Button>
              ) : undefined
            }
          />
        ) : (
          <Table ariaLabel="История бонусов">
            <TableHead sticky={false}>
              <tr>
                <Th>Дата</Th>
                <Th>Тип</Th>
                <Th align="right">Сумма</Th>
                <Th>Источник</Th>
                <Th>Комментарий</Th>
              </tr>
            </TableHead>
            <TableBody>
              {transactions.map((tx) => (
                <TableRow key={tx.id}>
                  <Td className="whitespace-nowrap font-mono text-xs text-ink-3">
                    {formatBonusTs(tx.created_at)}
                  </Td>
                  <Td>
                    <Badge size="sm">{typeLabel(tx.type)}</Badge>
                  </Td>
                  {/* Знак «+»/«−» несёт тот же смысл, что и цвет, — состояние не
                      закодировано одним только цветом (§5). */}
                  <Td numeric className={tx.amount > 0 ? 'text-good' : 'text-crit'}>
                    {formatAmount(tx.amount)}
                  </Td>
                  <Td className="text-ink-2">{sourceLabel(tx)}</Td>
                  <Td>
                    <span className="whitespace-pre-wrap break-words">{tx.comment ?? '—'}</span>
                    {!isCredit(tx.type) && tx.actor_player_id ? (
                      <span className="ml-2 inline-block align-middle">
                        <Badge size="sm">админ</Badge>
                      </span>
                    ) : null}
                  </Td>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        {nextCursor != null ? (
          <div className="flex justify-center">
            <Button size="sm" loading={busy} onClick={() => void loadMore()}>
              Показать ещё
            </Button>
          </div>
        ) : null}
      </CardBody>

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
    </Card>
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
  const tierSelectId = useId();

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
    <Modal
      open
      onClose={onClose}
      title="Купить привилегию"
      description="Покупка списывает бонусы, выдаёт роль привилегии на её срок и попадает в журнал аудита. Повторная покупка той же привилегии продлевает срок."
      size="sm"
      closeLabel="Закрыть"
      dismissible={!busy}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Отмена
          </Button>
          <Button
            variant="primary"
            onClick={() => void submit()}
            loading={busy}
            disabled={!selected || !affordable}
          >
            Купить
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {loading ? (
          <SkeletonTable rows={1} cols={1} label="Загрузка привилегий" />
        ) : tiers.length === 0 ? (
          <EmptyState
            title="Нет доступных привилегий"
            description="В магазине бонусов не настроено ни одной привилегии."
          />
        ) : (
          <FieldRow label="Привилегия" htmlFor={tierSelectId}>
            <Select id={tierSelectId} value={tierId} onChange={(e) => setTierId(e.target.value)}>
              <option value="">— выберите —</option>
              {tiers.map((tier) => (
                <option key={tier.id} value={tier.id}>
                  {tier.name} — {tier.price_bonuses} бонусов / {tier.default_days} дн.
                </option>
              ))}
            </Select>
          </FieldRow>
        )}

        {selected ? (
          <dl className="divide-y divide-line rounded-ctl border border-line text-xs">
            <div className="flex justify-between px-3 py-2">
              <dt className="text-ink-3">Цена</dt>
              <dd className="tabular-nums">{selected.price_bonuses}</dd>
            </div>
            <div className="flex justify-between px-3 py-2">
              <dt className="text-ink-3">Баланс</dt>
              <dd className="tabular-nums">{balance ?? '—'}</dd>
            </div>
            <div className="flex justify-between px-3 py-2">
              <dt className="text-ink-3">Останется</dt>
              <dd className={`tabular-nums ${affordable ? 'text-good' : 'text-crit'}`}>
                {balance != null && selected.price_bonuses != null
                  ? balance - selected.price_bonuses
                  : '—'}
              </dd>
            </div>
          </dl>
        ) : null}

        {selected && !affordable ? (
          <InlineBanner tone="warn" title="Недостаточно бонусов для покупки." />
        ) : null}

        {error ? <InlineBanner tone="crit" title={error} /> : null}
      </div>
    </Modal>
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
  const amountId = useId();
  const commentId = useId();

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
    <Modal
      open
      onClose={onClose}
      title="Корректировать баланс"
      description="Положительная сумма начисляет бонусы, отрицательная — списывает. Комментарий обязателен и попадёт в журнал аудита."
      size="sm"
      closeLabel="Закрыть"
      dismissible={!busy}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Отмена
          </Button>
          <Button variant="primary" onClick={() => void submit()} loading={busy}>
            Применить
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <FieldRow label="Сумма (±)" htmlFor={amountId}>
          <TextInput
            id={amountId}
            type="number"
            step={1}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="например, -50"
          />
        </FieldRow>

        <FieldRow label="Комментарий" htmlFor={commentId}>
          <Textarea
            id={commentId}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={3}
            maxLength={512}
            placeholder="причина корректировки"
          />
        </FieldRow>

        {error ? <InlineBanner tone="crit" title={error} /> : null}
      </div>
    </Modal>
  );
}
