import { hash, verify } from '@node-rs/argon2';

// OWASP 2024 baseline for Argon2id:
//   memory = 64 MiB, time (iterations) = 3, parallelism = 1
// @node-rs/argon2 exposes `Algorithm` as a const enum; with
// verbatimModuleSyntax we use the numeric value (Argon2id = 2) directly.
const ARGON2ID = 2 as const;

const ARGON_PARAMS = {
  algorithm: ARGON2ID,
  memoryCost: 64 * 1024,
  timeCost: 3,
  parallelism: 1,
  outputLen: 32,
  saltLength: 16,
} as const;

export async function hashPassword(plaintext: string): Promise<string> {
  return hash(plaintext, ARGON_PARAMS);
}

export async function verifyPassword(stored: string, plaintext: string): Promise<boolean> {
  try {
    return await verify(stored, plaintext);
  } catch {
    return false;
  }
}
