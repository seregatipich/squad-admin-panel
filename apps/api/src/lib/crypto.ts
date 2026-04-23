import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

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

export function deserialize(buf: Buffer): EncryptedBlob {
  return JSON.parse(buf.toString('utf-8')) as EncryptedBlob;
}
