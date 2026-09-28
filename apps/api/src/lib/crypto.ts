import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { z } from 'zod';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

export interface EncryptedBlob {
  /** Version tag; bumped whenever the scheme changes. */
  v: 1;
  /**
   * Key version recorded at encryption time. Informational only: key rotation
   * is not implemented, `decrypt` ignores this field and always uses the single
   * configured `APP_ENCRYPTION_KEY`, so changing that key makes every existing
   * blob undecryptable.
   */
  kv: number;
  /** Base64 IV (12 bytes). */
  iv: string;
  /** Base64 auth tag (16 bytes). */
  tag: string;
  /** Base64 ciphertext. */
  ct: string;
}

/**
 * Decode the base64-encoded APP_ENCRYPTION_KEY into a 32-byte key.
 * Throws if the key is not 32 bytes after decode.
 */
export function loadEncryptionKey(base64: string): Buffer {
  const raw = Buffer.from(base64, 'base64');
  if (raw.byteLength !== 32) {
    throw new Error(`APP_ENCRYPTION_KEY must decode to 32 bytes, got ${raw.byteLength}`);
  }
  return raw;
}

export function encrypt(key: Buffer, plaintext: string | Buffer, keyVersion = 1): EncryptedBlob {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv, { authTagLength: AUTH_TAG_BYTES });
  const pt = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf-8') : plaintext;
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    kv: keyVersion,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ct: ct.toString('base64'),
  };
}

export function decrypt(key: Buffer, blob: EncryptedBlob): Buffer {
  if (blob.v !== 1) throw new Error(`unsupported encryption version: ${blob.v}`);
  const iv = Buffer.from(blob.iv, 'base64');
  const tag = Buffer.from(blob.tag, 'base64');
  const ct = Buffer.from(blob.ct, 'base64');
  const decipher = createDecipheriv(ALGO, key, iv, { authTagLength: AUTH_TAG_BYTES });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

export function decryptString(key: Buffer, blob: EncryptedBlob): string {
  return decrypt(key, blob).toString('utf-8');
}

export function serialize(blob: EncryptedBlob): Buffer {
  return Buffer.from(JSON.stringify(blob), 'utf-8');
}

const encryptedBlobSchema = z.object({
  v: z.literal(1),
  kv: z.number().int(),
  iv: z.string().base64(),
  tag: z.string().base64(),
  ct: z.string().base64(),
});

/**
 * Parses a serialized {@link EncryptedBlob} read from a `bytea` column.
 *
 * @throws {Error} `invalid encrypted blob` when the bytes are not JSON or do not
 *   have the version-1 blob shape, instead of failing later inside `decrypt`.
 */
export function deserialize(buf: Buffer): EncryptedBlob {
  let raw: unknown;
  try {
    raw = JSON.parse(buf.toString('utf-8'));
  } catch {
    throw new Error('invalid encrypted blob: not JSON');
  }
  const parsed = encryptedBlobSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `invalid encrypted blob: ${parsed.error.issues.map((i) => i.path.join('.') || 'value').join(', ')}`,
    );
  }
  return parsed.data;
}
