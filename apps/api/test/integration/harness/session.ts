/** Session helpers of the integration harness. */

import { invalidatePermissionCache } from '../../../src/lib/rbac.js';
import { createSession } from '../../../src/lib/sessions.js';
import type { IntegrationHarness } from './types.js';

/**
 * Creates a real session for the seeded owner and returns the cookie header
 * string ready for subsequent `inject()` calls.
 */
export async function loginAsOwner(h: IntegrationHarness): Promise<string> {
  if (!h.seed.ownerPlayerId) {
    throw new Error('seed owner missing; pass seedOwner to buildIntegrationApp');
  }
  invalidatePermissionCache(h.seed.ownerPlayerId);
  const { token } = await createSession(h.db, h.redis, {
    playerId: h.seed.ownerPlayerId,
    ip: null,
    userAgent: 'test-harness',
    ttlMs: 21_600_000,
  });
  return `__Host-sid=${token}`;
}
