import { createCipheriv, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decrypt,
  decryptString,
  deserialize,
  type EncryptedBlob,
  loadEncryptionKey,
} from '../src/crypto.js';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

/**
 * Local reimplementation of the API's `encrypt()` + `serialize()`
 * (`apps/api/src/lib/crypto.ts`), used only to produce fixtures for this
 * round-trip test without importing the API package from a worker.
 */
function apiEncrypt(key: Buffer, plaintext: string, keyVersion = 1): EncryptedBlob {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv, { authTagLength: AUTH_TAG_BYTES });
  const ct = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    kv: keyVersion,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ct: ct.toString('base64'),
  };
}

function apiSerialize(blob: EncryptedBlob): Buffer {
  return Buffer.from(JSON.stringify(blob), 'utf-8');
}

describe('loadEncryptionKey', () => {
  it('decodes a valid base64 32-byte key', () => {
    const key = Buffer.alloc(32, 0x11).toString('base64');
    expect(loadEncryptionKey(key).byteLength).toBe(32);
  });

  it('throws for a key that does not decode to 32 bytes', () => {
    const shortKey = Buffer.alloc(16, 0x11).toString('base64');
    expect(() => loadEncryptionKey(shortKey)).toThrow(/32 bytes/);
  });
});

describe('decrypt / decryptString', () => {
  const key = Buffer.alloc(32, 0x42);

  it('round-trips a blob produced by the API encrypt+serialize scheme', () => {
    const blob = apiEncrypt(key, 'https://discord.com/api/webhooks/123/tokentoken');
    const serialized = apiSerialize(blob);
    const decrypted = decryptString(key, deserialize(serialized));
    expect(decrypted).toBe('https://discord.com/api/webhooks/123/tokentoken');
  });

  it('round-trips Cyrillic plaintext (multi-byte UTF-8)', () => {
    const blob = apiEncrypt(key, 'секретный вебхук');
    const decrypted = decryptString(key, blob);
    expect(decrypted).toBe('секретный вебхук');
  });

  it('throws when the auth tag does not match (tampered ciphertext)', () => {
    const blob = apiEncrypt(key, 'hello');
    const tampered: EncryptedBlob = { ...blob, ct: Buffer.from('tampered!!!!').toString('base64') };
    expect(() => decrypt(key, tampered)).toThrow();
  });

  it('throws for an unsupported blob version', () => {
    const blob = apiEncrypt(key, 'hello');
    expect(() => decrypt(key, { ...blob, v: 2 as 1 })).toThrow(/unsupported encryption version/);
  });

  it('throws when decrypted with the wrong key', () => {
    const blob = apiEncrypt(key, 'hello');
    const wrongKey = Buffer.alloc(32, 0x99);
    expect(() => decrypt(wrongKey, blob)).toThrow();
  });
});

describe('deserialize', () => {
  it('parses a JSON-serialized blob back into its object shape', () => {
    const key = Buffer.alloc(32, 0x07);
    const blob = apiEncrypt(key, 'round trip');
    const buf = apiSerialize(blob);
    expect(deserialize(buf)).toEqual(blob);
  });
});
