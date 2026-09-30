// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SubscriptionGrantSection } from './SubscriptionGrantSection';

const TEST_TIMEOUT_MS = 15_000;

const SUBSCRIPTION = {
  id: 'sub-1',
  tier_id: 'tier-1',
  tier_name: 'Бронза',
  status: 'active',
  renews_every_days: 30,
  price_bonuses: 100,
  next_renewal_at: '2026-08-26T10:00:00.000Z',
  created_at: '2026-07-27T10:00:00.000Z',
};

const SHOP_TIERS = {
  tiers: [
    { id: 'tier-1', name: 'Бронза', default_days: 30, price_bonuses: 100 },
    { id: 'tier-2', name: 'Без цены', default_days: 30, price_bonuses: null },
  ],
};

function stubApi(
  overrides: Array<{ match: string; method?: string; status: number; body?: unknown }> = [],
  subscriptions: unknown[] = [],
) {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body as string | undefined });
      const override = overrides.find(
        (o) => url.includes(o.match) && (o.method ?? 'GET') === method,
      );
      if (override) {
        return Promise.resolve(
          new Response(override.body !== undefined ? JSON.stringify(override.body) : null, {
            status: override.status,
          }),
        );
      }
      if (url.includes('/bonus-shop/tiers')) {
        return Promise.resolve(new Response(JSON.stringify(SHOP_TIERS), { status: 200 }));
      }
      if (url === '/api/v1/me') {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              can_manage_economy: true,
              permissions: ['user:manage_roles'],
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ rows: subscriptions }), { status: 200 }),
      );
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('SubscriptionGrantSection', () => {
  it(
    "renders the player's subscriptions",
    async () => {
      stubApi([], [SUBSCRIPTION]);
      render(<SubscriptionGrantSection playerId="player-1" />);

      await screen.findByRole('heading', { name: 'VIP-подписка' });
      const row = within(screen.getByRole('table')).getAllByRole('row')[1];
      if (!row) throw new Error('subscription row missing');
      expect(within(row).getByText('Бронза')).toBeInTheDocument();
      expect(within(row).getByText('Активна')).toBeInTheDocument();
      expect(within(row).getByText('100 бон.')).toBeInTheDocument();
      expect(within(row).getByText('30 дн.')).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'shows an empty state when the player has none',
    async () => {
      stubApi();
      render(<SubscriptionGrantSection playerId="player-1" />);

      await screen.findByText('Подписок нет');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'offers only priced tiers in the grant picker',
    async () => {
      stubApi();
      render(<SubscriptionGrantSection playerId="player-1" />);

      await screen.findByRole('button', { name: 'Выдать подписку' });
      const options = screen.getAllByRole('option');
      expect(options).toHaveLength(1);
      expect(options[0]).toHaveTextContent('Бронза');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'posts the selected tier and confirms the grant',
    async () => {
      const calls = stubApi([
        { match: '/subscriptions', method: 'POST', status: 201, body: { balance: 400 } },
      ]);
      render(<SubscriptionGrantSection playerId="player-1" />);

      fireEvent.click(await screen.findByRole('button', { name: 'Выдать подписку' }));

      await screen.findByText('Подписка выдана: первый период списан с баланса игрока.');
      const post = calls.find((c) => c.method === 'POST');
      expect(post?.url).toBe('/api/v1/players/player-1/subscriptions');
      expect(post?.body).toContain('tier-1');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'names the missing capability on a 403',
    async () => {
      stubApi([
        {
          match: '/subscriptions',
          method: 'POST',
          status: 403,
          body: { error: 'forbidden', required: 'can_assign_roles' },
        },
      ]);
      render(<SubscriptionGrantSection playerId="player-1" />);

      fireEvent.click(await screen.findByRole('button', { name: 'Выдать подписку' }));

      await screen.findByText('Недостаточно прав: требуется can_assign_roles.');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    // Regression (#460): the raw machine code used to be shown verbatim.
    'translates the API error code of a rejected grant into Russian',
    async () => {
      stubApi([
        {
          match: '/subscriptions',
          method: 'POST',
          status: 409,
          body: { error: 'already_subscribed' },
        },
      ]);
      render(<SubscriptionGrantSection playerId="player-1" />);

      fireEvent.click(await screen.findByRole('button', { name: 'Выдать подписку' }));

      await screen.findByText('У игрока уже есть активная VIP-подписка.');
      expect(screen.queryByText('already_subscribed')).not.toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'renders nothing for a reader without panel access',
    async () => {
      stubApi([{ match: '/subscriptions', status: 403 }]);
      const { container } = render(<SubscriptionGrantSection playerId="player-1" />);

      await vi.waitFor(() => expect(container).toBeEmptyDOMElement());
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'renders nothing when the session is gone',
    async () => {
      stubApi([{ match: '/subscriptions', status: 401 }]);
      const { container } = render(<SubscriptionGrantSection playerId="player-1" />);

      await vi.waitFor(() => expect(container).toBeEmptyDOMElement());
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'shows a load error when the list request fails',
    async () => {
      stubApi([{ match: '/subscriptions', status: 500 }]);
      render(<SubscriptionGrantSection playerId="player-1" />);

      // Regression (#460): a failed read used to be titled «Подписка не выдана».
      await screen.findByText('Не удалось загрузить подписки');
      expect(screen.getByText('HTTP 500')).toBeInTheDocument();
      expect(screen.queryByText('Подписка не выдана')).not.toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'retries a failed load and clears the stale error',
    async () => {
      let failing = true;
      vi.stubGlobal(
        'fetch',
        vi.fn((url: string) => {
          if (url.includes('/bonus-shop/tiers')) {
            return Promise.resolve(new Response(JSON.stringify(SHOP_TIERS), { status: 200 }));
          }
          if (failing) return Promise.resolve(new Response(null, { status: 500 }));
          return Promise.resolve(new Response(JSON.stringify({ rows: [] }), { status: 200 }));
        }),
      );
      render(<SubscriptionGrantSection playerId="player-1" />);

      await screen.findByText('Не удалось загрузить подписки');
      failing = false;
      fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));

      await screen.findByText('Подписок нет');
      expect(screen.queryByText('Не удалось загрузить подписки')).not.toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'explains a failed tier request instead of silently dropping the grant control',
    async () => {
      stubApi([{ match: '/bonus-shop/tiers', status: 500 }]);
      render(<SubscriptionGrantSection playerId="player-1" />);

      await screen.findByText('Не удалось загрузить тарифы');
      expect(screen.queryByRole('button', { name: 'Выдать подписку' })).not.toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'hides the grant control when no tier is purchasable',
    async () => {
      stubApi([{ match: '/bonus-shop/tiers', status: 200, body: { tiers: [] } }]);
      render(<SubscriptionGrantSection playerId="player-1" />);

      await screen.findByText('Подписок нет');
      expect(screen.queryByRole('button', { name: 'Выдать подписку' })).not.toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'hides the grant control for a panel user without can_manage_economy, even though tiers are purchasable (#459)',
    async () => {
      stubApi([
        {
          match: '/api/v1/me',
          status: 200,
          body: { can_manage_economy: false, permissions: ['user:manage_roles'] },
        },
      ]);
      render(<SubscriptionGrantSection playerId="player-1" />);

      await screen.findByText('Подписок нет');
      expect(screen.queryByRole('button', { name: 'Выдать подписку' })).not.toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'hides the grant control for a panel user without can_assign_roles, even though tiers are purchasable (#459)',
    async () => {
      stubApi([
        {
          match: '/api/v1/me',
          status: 200,
          body: { can_manage_economy: true, permissions: [] },
        },
      ]);
      render(<SubscriptionGrantSection playerId="player-1" />);

      await screen.findByText('Подписок нет');
      expect(screen.queryByRole('button', { name: 'Выдать подписку' })).not.toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );
});
