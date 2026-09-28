/**
 * Shared `AdminBan` duration syntax (see `buildAdminBanCommand` in
 * `apps/workers/rcon/src/commands.ts`): a bare number of days, or a number
 * followed by a unit suffix (`s`/`m`/`h`/`d`/`w`/`M`/`y`). `0` (with or
 * without a unit) means permanent.
 *
 * Both capture groups (amount, unit) are exposed for callers that need to
 * resolve the duration (see `parseBanLengthToExpiry` in
 * `apps/api/src/lib/banlist-publish.ts`); `.test()` works the same whether or
 * not the caller only needs validation.
 */
export const BAN_LENGTH_PATTERN = /^(\d+)([smhdwMy])?$/;

/** True when `value` (after trimming) matches the `AdminBan` duration syntax. */
export function isValidBanLength(value: string): boolean {
  return BAN_LENGTH_PATTERN.test(value.trim());
}
