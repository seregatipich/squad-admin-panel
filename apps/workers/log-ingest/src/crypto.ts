import { createDecipheriv } from 'node:crypto';

/**
 * Local subset of `apps/api/src/lib/crypto.ts`'s AES-256-GCM envelope,
 * re-implemented here to avoid coupling this worker to the API package
 * (same convention as `apps/workers/rcon/src/index.ts`). Only decryption is
 * needed: the API is the only writer of `ssh_private_key_encrypted`.
 */
export interface EncryptedBlob {
  v: 1;
  kv: number;
  iv: string;
  tag: string;
  ct: string;
}

const ALGO = 'aes-256-gcm';
const AUTH_TAG_BYTES = 16;

/** Decodes the base64 `APP_ENCRYPTION_KEY` env value into a 32-byte key, throwing if malformed. */
export function loadEncryptionKey(base64: string): Buffer {
  const raw = Buffer.from(base64, 'base64');
  if (raw.byteLength !== 32) {
    throw new Error(`APP_ENCRYPTION_KEY must decode to 32 bytes, got ${raw.byteLength}`);
  }
  return raw;
}

/** Parses the raw `bytea` column value into the JSON-encoded encrypted blob it stores. */
export function deserialize(buf: Buffer): EncryptedBlob {
  return JSON.parse(buf.toString('utf-8')) as EncryptedBlob;
}

export function decrypt(key: Buffer, blob: EncryptedBlob): string {
  if (blob.v !== 1) throw new Error(`unsupported encryption version: ${blob.v}`);
  const iv = Buffer.from(blob.iv, 'base64');
  const tag = Buffer.from(blob.tag, 'base64');
  const ct = Buffer.from(blob.ct, 'base64');
  const decipher = createDecipheriv(ALGO, key, iv, { authTagLength: AUTH_TAG_BYTES });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf-8');
}
