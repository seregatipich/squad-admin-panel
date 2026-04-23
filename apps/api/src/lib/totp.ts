import { randomBytes } from 'node:crypto';
import { encodeBase32UpperCaseNoPadding } from '@oslojs/encoding';
import { createTOTPKeyURI, verifyTOTP } from '@oslojs/otp';
import { hashPassword, verifyPassword } from './argon.js';

const TOTP_PERIOD_SECONDS = 30;
const TOTP_DIGITS = 6;
const BACKUP_CODE_COUNT = 8;
const BACKUP_CODE_LEN = 10;

export interface TotpProvision {
  /** Raw 20-byte secret, keep server-side, encrypt at rest. */
  secret: Uint8Array;
  /** otpauth://totp/... URI for QR rendering. */
  uri: string;
  /** Human-readable Base32 secret for manual entry. */
  manualEntry: string;
}

export function generateTotp(accountName: string, issuer = 'Squad Admin Panel'): TotpProvision {
  const secret = new Uint8Array(randomBytes(20));
  const uri = createTOTPKeyURI(issuer, accountName, secret, TOTP_PERIOD_SECONDS, TOTP_DIGITS);
  return {
    secret,
    uri,
    manualEntry: encodeBase32UpperCaseNoPadding(secret),
  };
}

export function verifyTotpCode(secret: Uint8Array, code: string): boolean {
  const cleaned = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(cleaned)) return false;
  return verifyTOTP(secret, TOTP_PERIOD_SECONDS, TOTP_DIGITS, cleaned);
}

export function currentStep(date = new Date()): number {
  return Math.floor(date.getTime() / 1000 / TOTP_PERIOD_SECONDS);
}

export interface BackupCodes {
  plainCodes: string[];
  hashedCodes: string[];
}

export async function generateBackupCodes(): Promise<BackupCodes> {
  const plainCodes: string[] = [];
  for (let i = 0; i < BACKUP_CODE_COUNT; i++) {
    const bytes = randomBytes(BACKUP_CODE_LEN);
    plainCodes.push(
      encodeBase32UpperCaseNoPadding(new Uint8Array(bytes))
        .slice(0, 10)
        .match(/.{1,5}/g)!
        .join('-'),
    );
  }
  const hashedCodes = await Promise.all(plainCodes.map((c) => hashPassword(c)));
  return { plainCodes, hashedCodes };
}

export async function consumeBackupCode(
  candidate: string,
  remainingHashed: string[],
): Promise<{ consumed: boolean; remaining: string[] }> {
  const normalized = candidate.trim().toUpperCase();
  for (let i = 0; i < remainingHashed.length; i++) {
    const stored = remainingHashed[i]!;
    if (await verifyPassword(stored, normalized)) {
      return {
        consumed: true,
        remaining: [...remainingHashed.slice(0, i), ...remainingHashed.slice(i + 1)],
      };
    }
  }
  return { consumed: false, remaining: remainingHashed };
}
