import { createCipheriv, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decrypt, deserialize } from '../src/crypto.js';

function encrypt(key: Buffer, plaintext: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  return {
    v: 1,
    kv: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
  };
}

describe('deserialize (#921)', () => {
  it('round-trips a valid blob through decrypt', () => {
    const key = randomBytes(32);
    const blob = deserialize(Buffer.from(JSON.stringify(encrypt(key, 'secret'))));
    expect(decrypt(key, blob)).toBe('secret');
  });

  it.each([
    ['non-JSON bytes', 'not json'],
    ['a missing field', JSON.stringify({ v: 1, kv: 1, iv: 'a', tag: 'b' })],
    ['a wrong version', JSON.stringify({ v: 2, kv: 1, iv: 'a', tag: 'b', ct: 'c' })],
  ])('rejects %s with an explicit format error', (_name, raw) => {
    expect(() => deserialize(Buffer.from(raw))).toThrow(/encrypted blob/);
  });
});
