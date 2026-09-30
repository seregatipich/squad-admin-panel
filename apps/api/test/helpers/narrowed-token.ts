import { playerApiTokens } from '@squad/db/schema';
import { mintApiToken } from '../../src/lib/api-tokens.js';
import type { IntegrationHarness } from '../integration/harness.js';

/**
 * Request headers of an API token that holds exactly `permissions`.
 *
 * A session user with `panel_access` derives every catalogue key outside the
 * role-flag gates, and a session of a role without `panel_access` is dropped
 * to anonymous (#33), so a session cannot hold "everything but X" or a small
 * exact set. A token of the seeded Owner is narrowed to `role ∩ scopes`
 * (`narrowToTokenScopes`), which can.
 *
 * @param h - Harness seeded with an owner (`seedOwner`).
 * @param permissions - Permission keys the token is scoped to.
 * @returns Headers to spread into `app.inject`.
 */
export async function narrowedOwnerHeaders(
  h: IntegrationHarness,
  permissions: readonly string[],
): Promise<{ authorization: string }> {
  if (!h.seed.ownerPlayerId) throw new Error('narrowedOwnerHeaders needs the seeded owner');
  const minted = mintApiToken();
  await h.db.insert(playerApiTokens).values({
    id: minted.id,
    playerId: h.seed.ownerPlayerId,
    name: `narrowed-${minted.id}`,
    tokenHash: minted.tokenHash,
    scopes: [...permissions],
  });
  return { authorization: `Bearer ${minted.plaintext}` };
}
