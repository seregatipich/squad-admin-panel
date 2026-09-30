import { describe, expect, it } from 'vitest';
import { decryptString, deserialize, encrypt, serialize } from '../src/lib/crypto.js';

const KEY = Buffer.alloc(32, 7);

describe('crypto blob round trip', () => {
  it('decrypts what it encrypted through serialize/deserialize', () => {
    const blob = deserialize(serialize(encrypt(KEY, 'rcon-secret')));
    expect(decryptString(KEY, blob)).toBe('rcon-secret');
  });
});

describe('deserialize (#66)', () => {
  it.each([
    ['non-JSON bytes', Buffer.from('not json')],
    ['a JSON value that is not an object', Buffer.from('"x"')],
    [
      'a blob missing its ciphertext',
      Buffer.from(JSON.stringify({ v: 1, kv: 1, iv: 'AA==', tag: 'AA==' })),
    ],
    [
      'an unsupported version',
      Buffer.from(JSON.stringify({ v: 2, kv: 1, iv: 'a', tag: 'b', ct: 'c' })),
    ],
    [
      'a non-integer key version',
      Buffer.from(JSON.stringify({ v: 1, kv: 'x', iv: 'a', tag: 'b', ct: 'c' })),
    ],
  ])('rejects %s with a clear error instead of a TypeError later', (_label, raw) => {
    expect(() => deserialize(raw)).toThrow('invalid encrypted blob');
  });
});
