import { generateTOTP } from '@oslojs/otp';
import { describe, expect, it } from 'vitest';
import {
  consumeBackupCode,
  currentStep,
  generateBackupCodes,
  generateTotp,
  verifyTotpCode,
} from '../src/lib/totp.js';

describe('TOTP secret + URI generation', () => {
  it('generateTotp returns 20-byte secret, otpauth URI and Base32 manual entry', () => {
    const p = generateTotp('user@example.com');
    expect(p.secret).toBeInstanceOf(Uint8Array);
    expect(p.secret.byteLength).toBe(20);
    expect(p.uri.startsWith('otpauth://totp/')).toBe(true);
    expect(p.uri).toContain('user%40example.com');
    expect(p.uri).toContain('issuer=Squad+Admin+Panel');
    expect(p.manualEntry).toMatch(/^[A-Z2-7]+$/);
    expect(p.manualEntry.length).toBeGreaterThanOrEqual(32);
  });

  it('generateTotp honours custom issuer', () => {
    const p = generateTotp('u', 'Acme');
    expect(p.uri).toContain('issuer=Acme');
  });
});

describe('TOTP code verification', () => {
  it('verifies a code generated for the current 30-second step', () => {
    const p = generateTotp('u@e.com');
    const code = generateTOTP(p.secret, 30, 6);
    expect(verifyTotpCode(p.secret, code)).toBe(true);
  });

  it('rejects codes that are not 6 digits', () => {
    const p = generateTotp('u@e.com');
    expect(verifyTotpCode(p.secret, '12345')).toBe(false);
    expect(verifyTotpCode(p.secret, '1234567')).toBe(false);
    expect(verifyTotpCode(p.secret, 'abcdef')).toBe(false);
  });

  it('tolerates whitespace in valid codes', () => {
    const p = generateTotp('u@e.com');
    const code = generateTOTP(p.secret, 30, 6);
    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
    expect(verifyTotpCode(p.secret, spaced)).toBe(true);
  });

  it('rejects a numeric code from an unrelated secret', () => {
    const a = generateTotp('a@e.com');
    const b = generateTotp('b@e.com');
    const codeForA = generateTOTP(a.secret, 30, 6);
    expect(verifyTotpCode(b.secret, codeForA)).toBe(false);
  });
});

describe('TOTP step arithmetic', () => {
  it('currentStep increments by 1 across a 30-second boundary', () => {
    const base = new Date('2026-04-23T00:00:00.000Z');
    const before = currentStep(base);
    const after = currentStep(new Date(base.getTime() + 30_000));
    expect(after - before).toBe(1);
  });

  it('currentStep with default argument uses Date.now()', () => {
    const s = currentStep();
    expect(Number.isInteger(s)).toBe(true);
    expect(s).toBeGreaterThan(0);
  });
});

describe('backup codes', () => {
  it('generateBackupCodes produces 8 codes shaped XXXXX-XXXXX with matching hashes', async () => {
    const { plainCodes, hashedCodes } = await generateBackupCodes();
    expect(plainCodes).toHaveLength(8);
    expect(hashedCodes).toHaveLength(8);
    for (const code of plainCodes) {
      expect(code).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
    }
    for (const h of hashedCodes) {
      expect(h.startsWith('$argon2id$')).toBe(true);
    }
  });

  it('consumeBackupCode accepts a valid code and removes its hash', async () => {
    const { plainCodes, hashedCodes } = await generateBackupCodes();
    const { consumed, remaining } = await consumeBackupCode(plainCodes[0]!, hashedCodes);
    expect(consumed).toBe(true);
    expect(remaining).toHaveLength(7);
    expect(remaining).not.toContain(hashedCodes[0]);
  });

  it('consumeBackupCode is case-insensitive and trims whitespace', async () => {
    const { plainCodes, hashedCodes } = await generateBackupCodes();
    const { consumed } = await consumeBackupCode(` ${plainCodes[1]!.toLowerCase()} `, hashedCodes);
    expect(consumed).toBe(true);
  });

  it('consumeBackupCode returns false on unknown code without mutating remaining', async () => {
    const { hashedCodes } = await generateBackupCodes();
    const { consumed, remaining } = await consumeBackupCode('AAAAA-BBBBB', hashedCodes);
    expect(consumed).toBe(false);
    expect(remaining).toEqual(hashedCodes);
  });

  it('consumed codes cannot be reused', async () => {
    const { plainCodes, hashedCodes } = await generateBackupCodes();
    const first = await consumeBackupCode(plainCodes[2]!, hashedCodes);
    expect(first.consumed).toBe(true);
    const second = await consumeBackupCode(plainCodes[2]!, first.remaining);
    expect(second.consumed).toBe(false);
  });
});
