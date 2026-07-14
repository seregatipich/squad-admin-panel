import { createDecipheriv } from 'node:crypto';

/**
 * Local re-implementation of the API's AES-256-GCM decrypt scheme
 * (`apps/api/src/lib/crypto.ts`), duplicated here so this worker doesn't
 * couple to the API package — mirrors the existing precedent in
 * `apps/workers/rcon/src/index.ts`. Any change to the API's encryption
 * scheme must be mirrored here; `test/crypto.test.ts` round-trips a blob
 * produced by a local reimplementation of the API's `encrypt()` to catch
 * drift between the two.
 */
export interface EncryptedBlob {
  /** Version tag; bumped whenever the scheme changes. */
  v: 1;
  /** Key version used to encrypt; allows rotation. */
  kv: number;
  /** Base64 IV (12 bytes). */
  iv: string;
  /** Base64 auth tag (16 bytes). */
  tag: string;
  /** Base64 ciphertext. */
  ct: string;
}

const ALGO = 'aes-256-gcm';
const AUTH_TAG_BYTES = 16;

/**
 * Decode the base64-encoded `APP_ENCRYPTION_KEY` into a 32-byte key.
 * Throws if the key is not 32 bytes after decode.
 */
export function loadEncryptionKey(base64: string): Buffer {
  const raw = Buffer.from(base64, 'base64');
  if (raw.byteLength !== 32) {
    throw new Error(`APP_ENCRYPTION_KEY must decode to 32 bytes, got ${raw.byteLength}`);
  }
  return raw;
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

/** Parses the JSON-serialized blob stored in a bytea column (matches the API's `serialize()`). */
export function deserialize(buf: Buffer): EncryptedBlob {
  return JSON.parse(buf.toString('utf-8')) as EncryptedBlob;
}
