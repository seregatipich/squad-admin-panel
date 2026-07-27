import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  hashUploadToken,
  mintUploadToken,
  uploadTokenUrl,
} from '../../src/lib/media-upload-tokens.js';

describe('mintUploadToken', () => {
  it('returns a high-entropy base64url token paired with its sha-256 hash', () => {
    const minted = mintUploadToken();
    expect(minted.raw).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(minted.hash).toBe(createHash('sha256').update(minted.raw).digest('hex'));
    expect(minted.hash).toHaveLength(64);
  });

  it('never repeats a token across mints', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(mintUploadToken().raw);
    expect(seen.size).toBe(200);
  });
});

describe('hashUploadToken', () => {
  it('is deterministic and irreversible in shape (hex digest, not the input)', () => {
    expect(hashUploadToken('abc')).toBe(hashUploadToken('abc'));
    expect(hashUploadToken('abc')).not.toBe('abc');
    expect(hashUploadToken('abc')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('separates tokens differing by a single character', () => {
    expect(hashUploadToken('token-a')).not.toBe(hashUploadToken('token-b'));
  });
});

describe('uploadTokenUrl', () => {
  it('builds the public upload URL under the panel origin', () => {
    expect(uploadTokenUrl('https://panel.test', 'abc123')).toBe('https://panel.test/upload/abc123');
  });

  it('tolerates a trailing slash on the configured panel URL', () => {
    expect(uploadTokenUrl('https://panel.test///', 'abc123')).toBe(
      'https://panel.test/upload/abc123',
    );
  });

  it('percent-encodes a token so it can never break out of the path segment', () => {
    expect(uploadTokenUrl('https://panel.test', 'a/b?c')).toBe(
      'https://panel.test/upload/a%2Fb%3Fc',
    );
  });
});
