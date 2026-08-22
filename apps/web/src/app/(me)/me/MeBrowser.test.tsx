// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MeBrowser } from './MeBrowser';

const TEST_TIMEOUT_MS = 15_000;

/**
 * jsdom 29 знает элемент `<dialog>`, но не реализует `showModal()`/`close()`,
 * а подтверждение отмены построено на примитиве `AlertDialog`. Полифилл
 * повторяет ровно то, на что опирается `Modal`: атрибут `open`, фокус внутрь
 * окна и цепочку Escape → отменяемое `cancel` → `close`.
 */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const escapeHandlers = new WeakMap<HTMLDialogElement, (event: KeyboardEvent) => void>();

if (typeof HTMLDialogElement.prototype.showModal !== 'function') {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const notPrevented = this.dispatchEvent(new Event('cancel', { cancelable: true }));
      if (notPrevented) this.close();
    };
    escapeHandlers.set(this, onKeyDown);
    this.addEventListener('keydown', onKeyDown);
    this.querySelector<HTMLElement>(FOCUSABLE)?.focus();
  };

  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement, value?: string) {
    if (value !== undefined) this.returnValue = value;
    this.removeAttribute('open');
    const onKeyDown = escapeHandlers.get(this);
    if (onKeyDown) {
      this.removeEventListener('keydown', onKeyDown);
      escapeHandlers.delete(this);
    }
    this.dispatchEvent(new Event('close'));
  };
}

const BALANCE = {
  player_id: 'player-1',
  balance: 250,
  role_id: 'role-1',
  role_expires_at: '2026-08-26T10:00:00.000Z',
};

const TIERS = {
  rows: [
    {
      tier_id: 'tier-1',
      name: 'Бронза',
      description: 'Приоритет в очереди',
      role_id: 'role-1',
      days: 30,
      price_bonuses: 100,
    },
  ],
};

const SUBSCRIPTION = {
  id: 'sub-1',
  player_id: 'player-1',
  tier_id: 'tier-1',
  tier_name: 'Бронза',
  status: 'active',
  renews_every_days: 30,
  price_bonuses: 100,
  next_renewal_at: '2026-08-26T10:00:00.000Z',
  created_at: '2026-07-27T10:00:00.000Z',
  cancelled_at: null,
};

const HISTORY = {
  items: [
    {
      id: 2,
      amount: -100,
      type: 'spend',
      reference_type: 'vip_subscription',
      comment: null,
      created_at: '2026-07-27T10:00:00.000Z',
    },
    {
      id: 1,
      amount: 350,
      type: 'earn_online',
      reference_type: 'daily_presence',
      comment: null,
      created_at: '2026-07-26T10:00:00.000Z',
    },
  ],
  next_cursor: null,
};

/**
 * Routes fetches by URL so the component's four parallel loads and any
 * subsequent mutation are all satisfied by one stub. `overrides` replaces the
 * response for a matching URL fragment.
 */
function stubApi(
  overrides: Array<{ match: string; status: number; body?: unknown }> = [],
  subscriptions: unknown[] = [],
) {
  const calls: Array<{ url: string; method: string }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET' });
      const override = overrides.find((o) => url.includes(o.match));
      if (override) {
        return Promise.resolve(
          new Response(override.body !== undefined ? JSON.stringify(override.body) : null, {
            status: override.status,
          }),
        );
      }
      const body = url.includes('/me/bonus-balance')
        ? BALANCE
        : url.includes('/me/tiers')
          ? TIERS
          : url.includes('/me/subscriptions')
            ? { rows: subscriptions }
            : HISTORY;
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('MeBrowser', () => {
  it(
    'renders the balance, VIP expiry and the ledger for the signed-in player',
    async () => {
      stubApi();
      render(<MeBrowser displayName="VipPlayer" />);

      await screen.findByText('250');
      expect(screen.getByText('VipPlayer')).toBeInTheDocument();
      expect(screen.getByText(/VIP активен до/)).toBeInTheDocument();
      expect(screen.getByText('−100')).toBeInTheDocument();
      expect(screen.getByText('+350')).toBeInTheDocument();
      expect(screen.getByText('Списание')).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'offers both a one-off purchase and a subscription for each tier',
    async () => {
      stubApi();
      render(<MeBrowser displayName="VipPlayer" />);

      await screen.findByText('Бронза');
      expect(screen.getByText(/100 бонусов за 30 дн\./)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Купить разово' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Подписаться' })).toBeEnabled();
      expect(screen.getByText('Активной подписки нет.')).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'posts a one-off purchase and reports success',
    async () => {
      const calls = stubApi([{ match: '/me/purchases', status: 201, body: { ok: true } }]);
      render(<MeBrowser displayName="VipPlayer" />);

      fireEvent.click(await screen.findByRole('button', { name: 'Купить разово' }));

      await screen.findByText('VIP продлён.');
      expect(calls.some((c) => c.url === '/api/v1/me/purchases' && c.method === 'POST')).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'surfaces the Russian message for insufficient_balance',
    async () => {
      stubApi([{ match: '/me/purchases', status: 409, body: { error: 'insufficient_balance' } }]);
      render(<MeBrowser displayName="VipPlayer" />);

      fireEvent.click(await screen.findByRole('button', { name: 'Купить разово' }));

      await screen.findByText('Недостаточно бонусов.');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'shows the active subscription and blocks a second one',
    async () => {
      stubApi([], [SUBSCRIPTION]);
      render(<MeBrowser displayName="VipPlayer" />);

      await screen.findByText(/Бронза — 100 бонусов каждые 30 дн\./);
      expect(screen.getByText(/Следующее списание:/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Подписаться' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Отменить подписку' })).toBeEnabled();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'cancels only after the confirmation dialog is accepted',
    async () => {
      const calls = stubApi(
        [{ match: '/me/subscriptions/sub-1', status: 200, body: { subscription: SUBSCRIPTION } }],
        [SUBSCRIPTION],
      );
      render(<MeBrowser displayName="VipPlayer" />);

      // Отказ в диалоге: подписка остаётся, запрос не уходит.
      fireEvent.click(await screen.findByRole('button', { name: 'Отменить подписку' }));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText(/Оплаченный период сохранится/)).toBeInTheDocument();
      // Подпись «Оставить подписку» носят и крестик окна, и кнопка подвала.
      const keeps = within(dialog).getAllByRole('button', { name: 'Оставить подписку' });
      fireEvent.click(keeps[keeps.length - 1] as HTMLElement);

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(calls.some((c) => c.method === 'DELETE')).toBe(false);

      // Подтверждение: запрос уходит и результат объявляется.
      fireEvent.click(screen.getByRole('button', { name: 'Отменить подписку' }));
      const confirmDialog = await screen.findByRole('dialog');
      fireEvent.click(within(confirmDialog).getByRole('button', { name: 'Отменить подписку' }));

      await screen.findByText('Подписка отменена. Оплаченный период сохранён.');
      expect(
        calls.some((c) => c.url === '/api/v1/me/subscriptions/sub-1' && c.method === 'DELETE'),
      ).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'reports a failed initial load instead of rendering stale data',
    async () => {
      stubApi([{ match: '/me/bonus-balance', status: 401, body: { error: 'unauthenticated' } }]);
      render(<MeBrowser displayName="VipPlayer" />);

      await screen.findByText('Сессия истекла — войдите заново.');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'says so when no VIP is active and no tiers are on sale',
    async () => {
      stubApi([
        {
          match: '/me/bonus-balance',
          status: 200,
          body: { ...BALANCE, role_id: null, role_expires_at: null, balance: 0 },
        },
        { match: '/me/tiers', status: 200, body: { rows: [] } },
        { match: '/me/bonus-transactions', status: 200, body: { items: [], next_cursor: null } },
      ]);
      render(<MeBrowser displayName="VipPlayer" />);

      await screen.findByText('VIP сейчас не активен.');
      expect(screen.getByText('Тарифы сейчас недоступны.')).toBeInTheDocument();
      expect(screen.getByText('Операций пока нет.')).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'pages the ledger with the returned cursor',
    async () => {
      const calls = stubApi([
        {
          match: '/me/bonus-transactions?limit=20&before=',
          status: 200,
          body: {
            items: [
              {
                id: 0,
                amount: 5,
                type: 'earn_seed',
                reference_type: null,
                comment: null,
                created_at: '2026-07-25T10:00:00.000Z',
              },
            ],
            next_cursor: null,
          },
        },
        {
          match: '/me/bonus-transactions?limit=20',
          status: 200,
          body: { ...HISTORY, next_cursor: 1 },
        },
      ]);
      render(<MeBrowser displayName="VipPlayer" />);

      fireEvent.click(await screen.findByRole('button', { name: 'Показать ещё' }));

      await screen.findByText('+5');
      expect(calls.some((c) => c.url.includes('before=1'))).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );
});
