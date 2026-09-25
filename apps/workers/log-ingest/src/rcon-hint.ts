import {
  encodeRconRefreshHint,
  RCON_REFRESH_CHANNEL,
  rconRefreshScopesForEvent,
} from '@squad/shared-config';
import type { EventEnvelope } from '@squad/shared-types';
import type Redis from 'ioredis';

/**
 * Tells worker-rcon to re-poll a server now because a log line just announced
 * a change RCON will report — a join, a leave, a match boundary. The log is
 * read in real time while RCON is polled on a timer, so without this nudge the
 * panel would show the new player only on the next roster tick.
 *
 * Returns whether a hint was sent. Best-effort: the poll timers still bring
 * the panel up to date if the publish fails.
 */
export async function publishRconRefreshHint(
  redis: Pick<Redis, 'publish'>,
  envelope: Pick<EventEnvelope, 'type' | 'server_id'>,
): Promise<boolean> {
  if (!envelope.server_id) return false;
  const scopes = rconRefreshScopesForEvent(envelope.type);
  if (!scopes) return false;
  await redis.publish(
    RCON_REFRESH_CHANNEL,
    encodeRconRefreshHint({ server_id: envelope.server_id, scopes, reason: envelope.type }),
  );
  return true;
}
