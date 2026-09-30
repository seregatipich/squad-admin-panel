import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DatabaseClient } from '@squad/db';
import { type SessionScope, sessions } from '@squad/db/schema';
import { eq, inArray, lt } from 'drizzle-orm';
import type Redis from 'ioredis';
import { v7 as uuidv7 } from 'uuid';

export interface SessionRecord {
  id: string;
  playerId: string;
  expiresAt: Date;
  lastActivityAt: Date;
  ip: string | null;
  userAgent: string | null;
  /** Authority the session carries; see `SESSION_SCOPES` in `@squad/db/schema`. */
  scope: SessionScope;
}

const REDIS_PREFIX = 'session:';
const REDIS_TTL_SECONDS = 600;

/**
 * Key that authenticates this process's session cache entries (#30, finding
 * #1254). Redis is reachable by every local process and by the RNSquadJS
 * sidecar, so an unauthenticated `session:<id>` entry would let anyone who
 * can write Redis mint a session for any player. Each entry carries an
 * HMAC over its session id and contents under this key; an entry that fails
 * the check is treated as a cache miss and the session is re-read from
 * Postgres, which stays the only source of truth. The key never leaves the
 * process, so entries written by an earlier process (before a restart) are
 * simply re-read once from the database.
 */
const CACHE_MAC_KEY = randomBytes(32);

function cacheMac(tokenId: string, payload: string): Buffer {
  return createHmac('sha256', CACHE_MAC_KEY).update(tokenId).update('\n').update(payload).digest();
}

/**
 * Minimal live-bus surface needed to push a forced logout. `app.liveBus`
 * satisfies this structurally, so callers pass it directly without coupling
 * this module to the full plugin type.
 */
export interface SessionRevokePublisher {
  publish(event: {
    type: 'session.revoked';
    ts: string;
    data: { player_id: string; session_id: string };
  }): void;
}

/**
 * Only an explicit `self_service` yields the restricted scope; anything else
 * resolves to `panel`.
 *
 * That direction is deliberate and safe: the column is `NOT NULL DEFAULT
 * 'panel'` under `sessions_scope_chk`, so an unknown value cannot exist in the
 * database. The only source of a missing value is a Redis cache entry written
 * by a process from before this migration — and every session that existed
 * then was a panel session, because a player without `panel_access` was never
 * issued one. Defaulting those to `self_service` would lock every admin out
 * mid-deploy for no security gain.
 */
function normalizeScope(value: string | null | undefined): SessionScope {
  return value === 'self_service' ? 'self_service' : 'panel';
}

export function mintSessionToken(): { token: string; tokenId: string } {
  const raw = randomBytes(24).toString('base64url');
  const token = `s_${uuidv7()}_${raw}`;
  const tokenId = createHash('sha256').update(token).digest('base64url');
  return { token, tokenId };
}

export function tokenIdFromToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

export async function createSession(
  db: DatabaseClient,
  redis: Redis,
  params: {
    playerId: string;
    ip: string | null;
    userAgent: string | null;
    ttlMs: number;
    /** Defaults to `panel`; pass `self_service` for a login without panel access. */
    scope?: SessionScope;
  },
): Promise<{ token: string; session: SessionRecord }> {
  const { token, tokenId } = mintSessionToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + params.ttlMs);
  const scope = params.scope ?? 'panel';
  await db.insert(sessions).values({
    id: tokenId,
    playerId: params.playerId,
    expiresAt,
    lastActivityAt: now,
    ip: params.ip,
    userAgent: params.userAgent,
    scope,
  });
  const record: SessionRecord = {
    id: tokenId,
    playerId: params.playerId,
    expiresAt,
    lastActivityAt: now,
    ip: params.ip,
    userAgent: params.userAgent,
    scope,
  };
  await cachePut(redis, record);
  return { token, session: record };
}

/**
 * Resolves a cookie token to its live session, serving from the Redis cache
 * when the cached entry is still within its deadline.
 *
 * A cached entry past its `expiresAt` is never trusted to revoke on its own:
 * `touchSession` extends the row in Postgres, so the cache can lag behind a
 * session that is still valid. Such an entry is dropped and the row re-read;
 * only a row that is expired in the database too is deleted (#52).
 *
 * @returns The session, or `null` when the token is unknown or expired.
 */
export async function resolveSession(
  db: DatabaseClient,
  redis: Redis,
  token: string,
): Promise<SessionRecord | null> {
  if (!token) return null;
  const tokenId = tokenIdFromToken(token);
  const cached = await cacheGet(redis, tokenId);
  if (cached) {
    if (cached.expiresAt.getTime() >= Date.now()) return cached;
    await invalidateSessionCache(redis, tokenId);
  }
  const rows = await db.select().from(sessions).where(eq(sessions.id, tokenId)).limit(1);
  const row = rows[0];
  if (!row) return null;
  if (row.expiresAt.getTime() <= Date.now()) {
    await revokeSession(db, redis, tokenId);
    return null;
  }
  const record: SessionRecord = {
    id: row.id,
    playerId: row.playerId,
    expiresAt: row.expiresAt,
    lastActivityAt: row.lastActivityAt,
    ip: row.ip ?? null,
    userAgent: row.userAgent ?? null,
    scope: normalizeScope(row.scope),
  };
  await cachePut(redis, record);
  return record;
}

/**
 * Drops the Redis cache entry of one session so the next `resolveSession`
 * reads the authoritative row from Postgres.
 *
 * @param redis - Redis client holding the `session:<id>` cache.
 * @param tokenId - Session id (SHA-256 of the cookie token).
 */
export async function invalidateSessionCache(
  redis: Pick<Redis, 'del'>,
  tokenId: string,
): Promise<void> {
  await redis.del(`${REDIS_PREFIX}${tokenId}`);
}

export async function revokeSession(
  db: DatabaseClient,
  redis: Redis,
  tokenId: string,
): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, tokenId));
  await redis.del(`${REDIS_PREFIX}${tokenId}`);
}

/**
 * Revokes every session belonging to `playerId` (DB rows + Redis cache).
 *
 * When a `publisher` is supplied, emits one `session.revoked` live-bus event
 * per revoked session so connected browser tabs for that player are force-
 * logged-out in real time (≤5 s) instead of only noticing on their next
 * request or account-page poll.
 */
export async function revokeAllForPlayer(
  db: DatabaseClient,
  redis: Redis,
  playerId: string,
  publisher?: SessionRevokePublisher,
): Promise<void> {
  await revokeAllForPlayers(db, redis, [playerId], publisher);
}

/** Redis `DEL` batch size: keeps each command's argument list bounded. */
const REVOKE_REDIS_DEL_BATCH = 1_000;

/**
 * Bulk form of {@link revokeAllForPlayer}: one `DELETE … WHERE player_id =
 * ANY(…) RETURNING` for every listed player, then batched Redis `DEL`s, so a
 * role change touching thousands of players costs a handful of round trips
 * instead of several per player.
 *
 * @param db - database handle.
 * @param redis - session cache.
 * @param playerIds - players whose sessions are revoked; may be empty.
 * @param publisher - when given, receives one `session.revoked` event per
 *   revoked session.
 */
export async function revokeAllForPlayers(
  db: DatabaseClient,
  redis: Redis,
  playerIds: readonly string[],
  publisher?: SessionRevokePublisher,
): Promise<void> {
  if (playerIds.length === 0) return;
  const rows = await db
    .delete(sessions)
    .where(inArray(sessions.playerId, [...playerIds]))
    .returning({ id: sessions.id, playerId: sessions.playerId });
  if (rows.length === 0) return;
  for (let i = 0; i < rows.length; i += REVOKE_REDIS_DEL_BATCH) {
    const batch = rows.slice(i, i + REVOKE_REDIS_DEL_BATCH);
    await redis.del(...batch.map((r) => `${REDIS_PREFIX}${r.id}`));
  }
  if (!publisher) return;
  const ts = new Date().toISOString();
  for (const r of rows) {
    publisher.publish({
      type: 'session.revoked',
      ts,
      data: { player_id: r.playerId, session_id: r.id },
    });
  }
}

/**
 * Deletes every session whose `expires_at` has passed. Called on a timer by
 * the `session-prune` plugin.
 *
 * @returns the number of rows deleted (postgres.js reports it as `count`).
 */
export async function pruneExpired(db: DatabaseClient): Promise<number> {
  const result = await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
  return result.count;
}

export interface TouchSessionInput {
  sessionId: string;
  redis: Pick<Redis, 'set'>;
  now: Date;
  ttlSeconds: number;
  throttleSeconds: number;
  updateDb: (newExpiresAt: Date, newLastActivity: Date) => Promise<void>;
}

export async function touchSession(input: TouchSessionInput): Promise<boolean> {
  const ok = await input.redis.set(
    `session-touch:${input.sessionId}`,
    '1',
    'EX',
    input.throttleSeconds,
    'NX',
  );
  if (ok !== 'OK') return false;
  const newExpiresAt = new Date(input.now.getTime() + input.ttlSeconds * 1000);
  await input.updateDb(newExpiresAt, input.now);
  return true;
}

async function cachePut(redis: Redis, record: SessionRecord): Promise<void> {
  const payload = JSON.stringify({
    playerId: record.playerId,
    expiresAt: record.expiresAt.toISOString(),
    lastActivityAt: record.lastActivityAt.toISOString(),
    ip: record.ip,
    userAgent: record.userAgent,
    scope: record.scope,
  });
  await redis.set(
    `${REDIS_PREFIX}${record.id}`,
    JSON.stringify({ payload, mac: cacheMac(record.id, payload).toString('base64url') }),
    'EX',
    REDIS_TTL_SECONDS,
  );
}

/**
 * Reads a session from the Redis cache, or `null` on a miss — including any
 * entry whose HMAC does not verify (forged, tampered, legacy-format, or
 * written by another process), so the caller falls back to Postgres.
 */
async function cacheGet(redis: Redis, tokenId: string): Promise<SessionRecord | null> {
  const raw = await redis.get(`${REDIS_PREFIX}${tokenId}`);
  if (!raw) return null;
  try {
    const envelope = JSON.parse(raw) as { payload?: unknown; mac?: unknown };
    if (typeof envelope.payload !== 'string' || typeof envelope.mac !== 'string') return null;
    const expected = cacheMac(tokenId, envelope.payload);
    const actual = Buffer.from(envelope.mac, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    const obj = JSON.parse(envelope.payload) as {
      playerId: string;
      expiresAt: string;
      lastActivityAt: string;
      ip: string | null;
      userAgent: string | null;
      scope?: string;
    };
    return {
      id: tokenId,
      playerId: obj.playerId,
      expiresAt: new Date(obj.expiresAt),
      lastActivityAt: new Date(obj.lastActivityAt),
      ip: obj.ip,
      userAgent: obj.userAgent,
      scope: normalizeScope(obj.scope),
    };
  } catch {
    return null;
  }
}
