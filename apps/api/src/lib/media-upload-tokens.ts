import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseClient } from '@squad/db';
import { type MediaUploadTokenRow, mediaUploadTokens } from '@squad/db/schema';
import { and, eq, isNull, sql } from 'drizzle-orm';

/**
 * Raw upload-token entropy. 32 bytes is 43 base64url characters — far beyond
 * any feasible enumeration of the `/upload/<token>` space.
 */
const UPLOAD_TOKEN_BYTES = 32;

export interface MintedUploadToken {
  /** Shown to the minter exactly once; never persisted, logged, or audited. */
  raw: string;
  /** Hex sha-256 of `raw` — the only form written to `media_upload_tokens`. */
  hash: string;
}

export function mintUploadToken(): MintedUploadToken {
  const raw = randomBytes(UPLOAD_TOKEN_BYTES).toString('base64url');
  return { raw, hash: hashUploadToken(raw) };
}

export function hashUploadToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** Builds the one-time public upload URL handed to the anonymous uploader. */
export function uploadTokenUrl(panelPublicUrl: string, raw: string): string {
  return `${panelPublicUrl.replace(/\/+$/, '')}/upload/${encodeURIComponent(raw)}`;
}

/** Looks a token row up by the raw value presented on the public endpoint. */
export async function loadUploadTokenByRaw(
  db: DatabaseClient,
  raw: string,
): Promise<MediaUploadTokenRow | null> {
  const rows = await db
    .select()
    .from(mediaUploadTokens)
    .where(eq(mediaUploadTokens.tokenHash, hashUploadToken(raw)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Atomically burns a token, returning `false` when it was already spent or has
 * expired. Single use is a database property, not an application one: the
 * conditional `UPDATE ... RETURNING` takes a row lock, so of two concurrent
 * uploads racing on the same token exactly one can observe a returned row.
 * `now()` is evaluated by Postgres so the expiry clock is the database's.
 */
export async function redeemUploadToken(db: DatabaseClient, tokenId: string): Promise<boolean> {
  const claimed = await db
    .update(mediaUploadTokens)
    .set({ usedAt: sql`now()` })
    .where(
      and(
        eq(mediaUploadTokens.id, tokenId),
        isNull(mediaUploadTokens.usedAt),
        sql`${mediaUploadTokens.expiresAt} > now()`,
      ),
    )
    .returning({ id: mediaUploadTokens.id });
  return claimed.length > 0;
}

/** True when a token row is still redeemable — cheap pre-check before accepting bytes. */
export function isUploadTokenRedeemable(row: MediaUploadTokenRow, now: Date = new Date()): boolean {
  return row.usedAt === null && row.expiresAt.getTime() > now.getTime();
}
