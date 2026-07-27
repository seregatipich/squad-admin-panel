import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseClient } from '@squad/db';
import { type SessionScope, sessions } from '@squad/db/schema';
import { and, eq, gt, lt } from 'drizzle-orm';
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
 * Fails closed: a row or cache entry written before the scope column existed
 * (or carrying an unknown value) is treated as the restrictive scope only if
 * it is explicitly `self_service`. Everything else keeps the historical
 * `panel` behaviour, so no live session is downgraded by a deploy.
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

export async function resolveSession(
  db: DatabaseClient,
  redis: Redis,
  token: string,
): Promise<SessionRecord | null> {
  if (!token) return null;
  const tokenId = tokenIdFromToken(token);
  const cached = await cacheGet(redis, tokenId);
  if (cached) {
    if (cached.expiresAt.getTime() < Date.now()) {
      await revokeSession(db, redis, tokenId);
      return null;
    }
    return cached;
  }
  const rows = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, tokenId), gt(sessions.expiresAt, new Date())))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
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
  const rows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.playerId, playerId));
  if (rows.length) {
    await db.delete(sessions).where(eq(sessions.playerId, playerId));
    await redis.del(...rows.map((r) => `${REDIS_PREFIX}${r.id}`));
    if (publisher) {
      const ts = new Date().toISOString();
      for (const r of rows) {
        publisher.publish({
          type: 'session.revoked',
          ts,
          data: { player_id: playerId, session_id: r.id },
        });
      }
    }
  }
}

export async function pruneExpired(db: DatabaseClient): Promise<number> {
  const result = await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
  return (result as unknown as { rowCount?: number }).rowCount ?? 0;
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
    'EX' as never,
    input.throttleSeconds as never,
    'NX' as never,
  );
  if (ok !== 'OK') return false;
  const newExpiresAt = new Date(input.now.getTime() + input.ttlSeconds * 1000);
  await input.updateDb(newExpiresAt, input.now);
  return true;
}

async function cachePut(redis: Redis, record: SessionRecord): Promise<void> {
  await redis.set(
    `${REDIS_PREFIX}${record.id}`,
    JSON.stringify({
      playerId: record.playerId,
      expiresAt: record.expiresAt.toISOString(),
      lastActivityAt: record.lastActivityAt.toISOString(),
      ip: record.ip,
      userAgent: record.userAgent,
      scope: record.scope,
    }),
    'EX',
    REDIS_TTL_SECONDS,
  );
}

async function cacheGet(redis: Redis, tokenId: string): Promise<SessionRecord | null> {
  const raw = await redis.get(`${REDIS_PREFIX}${tokenId}`);
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as {
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
