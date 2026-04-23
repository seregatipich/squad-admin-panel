import { describe, expect, it } from 'vitest';
import { decryptString, encrypt, loadEncryptionKey } from '../src/lib/crypto.js';

describe('AES-256-GCM crypto helper', () => {
  it('round-trips a secret through encrypt/decrypt', () => {
    const key = loadEncryptionKey(Buffer.alloc(32, 0x11).toString('base64'));
    const plaintext = 'super-secret-rcon-password';
    const blob = encrypt(key, plaintext);
    expect(decryptString(key, blob)).toBe(plaintext);
  });

  it('rejects a wrong-length key', () => {
    expect(() => loadEncryptionKey('short')).toThrow(/must decode to 32 bytes/);
  });

  it('rejects ciphertext with tampered auth tag', () => {
    const key = loadEncryptionKey(Buffer.alloc(32, 0x22).toString('base64'));
    const blob = encrypt(key, 'canary');
    const tampered = { ...blob, tag: Buffer.alloc(16, 0x00).toString('base64') };
    expect(() => decryptString(key, tampered)).toThrow();
  });
});
