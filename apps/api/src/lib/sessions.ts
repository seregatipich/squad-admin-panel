import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseClient } from '@squad/db';
import { sessions } from '@squad/db/schema';
import { and, eq, gt, lt } from 'drizzle-orm';
import type Redis from 'ioredis';
import { v7 as uuidv7 } from 'uuid';

export interface SessionRecord {
  id: string;
  userId: string;
  expiresAt: Date;
  ip: string | null;
  userAgent: string | null;
}

const REDIS_PREFIX = 'session:';
const REDIS_TTL_SECONDS = 600;

/**
 * Generate a new opaque session ID. The returned value is the token the
 * client stores in the __Host-sid cookie; the database key is the SHA-256
 * of the token so leaking the DB still doesn't expose valid tokens.
 */
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
  params: { userId: string; ip: string | null; userAgent: string | null; ttlMs: number },
): Promise<{ token: string; session: SessionRecord }> {
  const { token, tokenId } = mintSessionToken();
  const expiresAt = new Date(Date.now() + params.ttlMs);
  await db.insert(sessions).values({
    id: tokenId,
    userId: params.userId,
    expiresAt,
    ip: params.ip,
    userAgent: params.userAgent,
  });
  const record: SessionRecord = {
    id: tokenId,
    userId: params.userId,
    expiresAt,
    ip: params.ip,
    userAgent: params.userAgent,
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
    userId: row.userId,
    expiresAt: row.expiresAt,
    ip: row.ip ?? null,
    userAgent: row.userAgent ?? null,
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

export async function revokeAllForUser(
  db: DatabaseClient,
  redis: Redis,
  userId: string,
): Promise<void> {
  const rows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.userId, userId));
  if (rows.length) {
    await db.delete(sessions).where(eq(sessions.userId, userId));
    await redis.del(...rows.map((r) => `${REDIS_PREFIX}${r.id}`));
  }
}

export async function pruneExpired(db: DatabaseClient): Promise<number> {
  const result = await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
  return (result as unknown as { rowCount?: number }).rowCount ?? 0;
}

async function cachePut(redis: Redis, record: SessionRecord): Promise<void> {
  await redis.set(
    `${REDIS_PREFIX}${record.id}`,
    JSON.stringify({
      userId: record.userId,
      expiresAt: record.expiresAt.toISOString(),
      ip: record.ip,
      userAgent: record.userAgent,
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
      userId: string;
      expiresAt: string;
      ip: string | null;
      userAgent: string | null;
    };
    return {
      id: tokenId,
      userId: obj.userId,
      expiresAt: new Date(obj.expiresAt),
      ip: obj.ip,
      userAgent: obj.userAgent,
    };
  } catch {
    return null;
  }
}
