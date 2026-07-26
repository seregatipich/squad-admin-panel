// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/settings/economy'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

import type { EconomySettings, VipTier } from './helpers';
import EconomySettingsPage from './page';

function makeSettings(): EconomySettings {
  return {
    k_online: 1,
    k_boost: 2,
    k_seed: 3,
    seed_threshold: 40,
    economy_enabled: false,
    privilege_costs: {},
    updated_at: null,
    updated_by_player_id: null,
  };
}

function makeTier(overrides: Partial<VipTier> = {}): VipTier {
  return {
    id: overrides.id ?? 'tier-1',
    name: overrides.name ?? 'VIP Bronze',
    role_id: overrides.role_id ?? 'role-1',
    description: 'description' in overrides ? (overrides.description ?? null) : null,
    default_days: 'default_days' in overrides ? (overrides.default_days ?? null) : 30,
    sort_order: overrides.sort_order ?? 0,
    is_active: overrides.is_active ?? true,
    created_at: overrides.created_at ?? '2026-07-01T00:00:00.000Z',
    updated_at: overrides.updated_at ?? '2026-07-01T00:00:00.000Z',
  };
}

/**
 * Mock fetch serving the economy page's data endpoints and recording tier
 * mutations (POST /api/v1/vip-tiers, DELETE /api/v1/vip-tiers/:id).
 */
function stubFetch(opts: {
  tiers?: VipTier[];
  permissions?: string[];
  onPost?: (body: Record<string, unknown>) => void;
  onDelete?: (url: string) => void;
}) {
  const perms = opts.permissions ?? ['role:edit'];
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.endsWith('/api/v1/settings/economy') && method === 'GET') {
      return Promise.resolve(new Response(JSON.stringify(makeSettings()), { status: 200 }));
    }
    if (url.endsWith('/api/v1/me')) {
      return Promise.resolve(
        new Response(JSON.stringify({ can_manage_economy: true, permissions: perms }), {
          status: 200,
        }),
      );
    }
    if (url.endsWith('/api/v1/roles') && method === 'GET') {
      return Promise.resolve(
        new Response(
          JSON.stringify([
            { id: 'role-1', name: 'VIP Role' },
            { id: 'role-2', name: 'Premium Role' },
          ]),
          { status: 200 },
        ),
      );
    }
    if (url.endsWith('/api/v1/vip-tiers') && method === 'GET') {
      return Promise.resolve(
        new Response(JSON.stringify({ rows: opts.tiers ?? [] }), { status: 200 }),
      );
    }
    if (url.endsWith('/api/v1/vip-tiers') && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      opts.onPost?.(body);
      return Promise.resolve(
        new Response(
          JSON.stringify(
            makeTier({ id: 'tier-new', name: String(body.name), role_id: String(body.role_id) }),
          ),
          { status: 201 },
        ),
      );
    }
    if (url.includes('/api/v1/vip-tiers/') && method === 'DELETE') {
      opts.onDelete?.(url);
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    }
    return Promise.resolve(new Response('{}', { status: 200 }));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('EconomySettingsPage — VIP tiers section (VIPSUB-3)', () => {
  it('renders VIP tiers section with tiers from the API', async () => {
    stubFetch({
      tiers: [
        makeTier({ id: 'tier-1', name: 'VIP Bronze', default_days: 30 }),
        makeTier({ id: 'tier-2', name: 'VIP Gold', role_id: 'role-2', default_days: null }),
      ],
    });
    render(<EconomySettingsPage />);
    const section = await screen.findByRole('region', { name: 'VIP-тиры' });
    const scope = within(section);
    expect(scope.getByText('VIP Bronze')).toBeInTheDocument();
    expect(scope.getByText('VIP Gold')).toBeInTheDocument();
    // The role_id column resolves role names from /api/v1/roles.
    expect(scope.getByText('VIP Role')).toBeInTheDocument();
    expect(scope.getByText('Premium Role')).toBeInTheDocument();
    // default_days renders via formatTierDuration.
    expect(scope.getByText('30 дн.')).toBeInTheDocument();
    expect(scope.getByText('бессрочно')).toBeInTheDocument();
  });

  it('hides VIP tiers section without role:edit permission', async () => {
    stubFetch({ tiers: [makeTier()], permissions: [] });
    render(<EconomySettingsPage />);
    await screen.findByRole('heading', { name: 'Экономика организации' });
    expect(screen.queryByRole('region', { name: 'VIP-тиры' })).not.toBeInTheDocument();
    expect(screen.queryByText('VIP Bronze')).not.toBeInTheDocument();
  });

  it('creates a tier via POST /api/v1/vip-tiers', async () => {
    const posted: Record<string, unknown>[] = [];
    stubFetch({ tiers: [], onPost: (b) => posted.push(b) });
    render(<EconomySettingsPage />);
    const section = await screen.findByRole('region', { name: 'VIP-тиры' });
    const scope = within(section);

    fireEvent.click(scope.getByRole('button', { name: /добавить тир/i }));
    fireEvent.change(scope.getByLabelText('Название тира'), { target: { value: 'VIP Silver' } });
    fireEvent.change(scope.getByLabelText('Роль тира'), { target: { value: 'role-2' } });
    fireEvent.change(scope.getByLabelText('Срок по умолчанию (дней)'), {
      target: { value: '90' },
    });
    fireEvent.click(scope.getByRole('button', { name: /сохранить тир/i }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({
      name: 'VIP Silver',
      role_id: 'role-2',
      default_days: 90,
      is_active: true,
    });
  });

  it('delete asks for confirmation and calls DELETE', async () => {
    const deleted: string[] = [];
    const confirmMock = vi.fn(() => true);
    vi.stubGlobal('confirm', confirmMock);
    stubFetch({
      tiers: [makeTier({ id: 'tier-1', name: 'VIP Bronze' })],
      onDelete: (u) => deleted.push(u),
    });
    render(<EconomySettingsPage />);
    const section = await screen.findByRole('region', { name: 'VIP-тиры' });
    fireEvent.click(within(section).getByRole('button', { name: /удалить тир «VIP Bronze»/i }));

    await waitFor(() => expect(deleted).toHaveLength(1));
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(deleted[0]).toContain('/api/v1/vip-tiers/tier-1');
  });
});
