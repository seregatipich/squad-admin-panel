import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/lib/argon.js';

describe('argon2id password hashing', () => {
  it('hashPassword produces an argon2id PHC string', async () => {
    const hashed = await hashPassword('correct-horse-battery-staple');
    expect(hashed.startsWith('$argon2id$')).toBe(true);
  });

  it('verifyPassword returns true on correct plaintext', async () => {
    const plaintext = 'correct-horse-battery-staple';
    const hashed = await hashPassword(plaintext);
    expect(await verifyPassword(hashed, plaintext)).toBe(true);
  });

  it('verifyPassword returns false on wrong plaintext', async () => {
    const hashed = await hashPassword('secret-one');
    expect(await verifyPassword(hashed, 'secret-two')).toBe(false);
  });

  it('verifyPassword returns false (no throw) on malformed hash', async () => {
    expect(await verifyPassword('$not-a-real$phc-string', 'whatever')).toBe(false);
  });

  it('hashPassword produces distinct hashes for identical inputs (salted)', async () => {
    const plaintext = 'same-password';
    const a = await hashPassword(plaintext);
    const b = await hashPassword(plaintext);
    expect(a).not.toBe(b);
    expect(await verifyPassword(a, plaintext)).toBe(true);
    expect(await verifyPassword(b, plaintext)).toBe(true);
  });
});
