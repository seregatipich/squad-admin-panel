import { z } from 'zod';

/**
 * Response schemas of the economy settings page endpoints. The web UI parses
 * every response with `safeParse` instead of trusting an `as` cast, so a
 * server/client shape drift shows an error instead of crashing at render time.
 * Unknown extra keys are stripped, which keeps additive server changes
 * compatible with older web bundles.
 */

/** Body of GET/PUT `/api/v1/settings/economy` (server `serialize()`). */
export const economySettingsResponse = z.object({
  k_online: z.number(),
  k_boost: z.number(),
  k_seed: z.number(),
  seed_threshold: z.number(),
  economy_enabled: z.boolean(),
  privilege_costs: z.record(z.object({ days: z.number(), price: z.number() })),
  seed_reward_threshold_hours_per_month: z.number(),
  seed_reward_role_id: z.string().nullable(),
  vip_expiry_windows_days: z.array(z.number()),
  vip_expiry_warn_in_game: z.boolean(),
  updated_at: z.string().nullable(),
  updated_by_player_id: z.string().nullable(),
});
export type EconomySettingsResponse = z.infer<typeof economySettingsResponse>;

/** One VIP tier as returned by `/api/v1/vip-tiers` (server `serialize()`). */
export const vipTierResponse = z.object({
  id: z.string(),
  name: z.string(),
  role_id: z.string(),
  description: z.string().nullable(),
  default_days: z.number().nullable(),
  price_bonuses: z.number().nullable(),
  sort_order: z.number(),
  is_active: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type VipTierResponse = z.infer<typeof vipTierResponse>;

/** Body of GET `/api/v1/vip-tiers`. */
export const vipTierListResponse = z.object({ rows: z.array(vipTierResponse) });

/** The role fields the tier role picker needs from GET `/api/v1/roles`. */
export const roleOptionResponse = z.object({
  id: z.string(),
  name: z.string(),
  panel_access: z.boolean(),
  is_system_role: z.boolean(),
});
export type RoleOptionResponse = z.infer<typeof roleOptionResponse>;

/** Body of GET `/api/v1/roles`. */
export const roleOptionListResponse = z.array(roleOptionResponse);

/** The `/api/v1/me` fields the economy page reads. */
export const economyMeResponse = z.object({
  can_manage_economy: z.boolean(),
  permissions: z.array(z.string()),
});
export type EconomyMeResponse = z.infer<typeof economyMeResponse>;
