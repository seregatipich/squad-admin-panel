import { describe, expect, it } from 'vitest';
import {
  economyMeResponse,
  economySettingsResponse,
  roleOptionListResponse,
  vipTierListResponse,
} from '../src/economy.js';

const settings = {
  k_online: 1,
  k_boost: 2,
  k_seed: 3,
  seed_threshold: 40,
  economy_enabled: true,
  privilege_costs: { vip: { days: 30, price: 100 } },
  seed_reward_threshold_hours_per_month: 0,
  seed_reward_role_id: null,
  vip_expiry_windows_days: [7, 3, 1],
  vip_expiry_warn_in_game: true,
  updated_at: null,
  updated_by_player_id: null,
};

const tier = {
  id: 't1',
  name: 'VIP',
  role_id: 'r1',
  description: null,
  default_days: 30,
  price_bonuses: null,
  sort_order: 0,
  is_active: true,
  created_at: '2026-07-01T00:00:00.000Z',
  updated_at: '2026-07-01T00:00:00.000Z',
};

describe('economy response schemas', () => {
  it('accepts the server shape and strips unknown keys', () => {
    const parsed = economySettingsResponse.parse({ ...settings, future_field: 1 });
    expect(parsed).toEqual(settings);
  });

  it('rejects settings missing the vip expiry fields', () => {
    const { vip_expiry_windows_days: _omitted, ...incomplete } = settings;
    expect(economySettingsResponse.safeParse(incomplete).success).toBe(false);
  });

  it('requires the tier list to be wrapped in rows', () => {
    expect(vipTierListResponse.safeParse({ rows: [tier] }).success).toBe(true);
    expect(vipTierListResponse.safeParse([tier]).success).toBe(false);
  });

  it('requires roles to be an array carrying the guard flags', () => {
    const role = { id: 'r1', name: 'VIP', panel_access: false, is_system_role: false };
    expect(roleOptionListResponse.safeParse([role]).success).toBe(true);
    expect(roleOptionListResponse.safeParse({ rows: [role] }).success).toBe(false);
    expect(roleOptionListResponse.safeParse([{ id: 'r1', name: 'VIP' }]).success).toBe(false);
  });

  it('requires the me permission list', () => {
    expect(economyMeResponse.safeParse({ can_manage_economy: true }).success).toBe(false);
  });
});
