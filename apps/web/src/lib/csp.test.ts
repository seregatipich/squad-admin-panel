import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy, createNonce } from './csp';

function scriptSrc(policy: string): string {
  return policy.split('; ').find((directive) => directive.startsWith('script-src ')) ?? '';
}

describe('contentSecurityPolicy', () => {
  // #60 finding 424: production `script-src` carried 'unsafe-inline', so any
  // injected <script> or onerror= handler would have run with operator rights.
  it("never allows inline scripts in production, only the request's nonce", () => {
    const policy = contentSecurityPolicy({ nonce: 'abc123', production: true });

    expect(scriptSrc(policy)).toBe("script-src 'self' 'nonce-abc123'");
    expect(scriptSrc(policy)).not.toContain("'unsafe-inline'");
    expect(scriptSrc(policy)).not.toContain("'unsafe-eval'");
  });

  // #1306/#1307: Steam avatars, Monaco's data: images/font and blob: workers must
  // work on every page, because soft (next/link) navigation keeps the policy of
  // the document that was loaded first.
  it('keeps the production policy exact', () => {
    const expected =
      "default-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; script-src 'self' 'nonce-n1'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://avatars.steamstatic.com https://avatars.akamai.steamstatic.com; font-src 'self' data:; worker-src 'self' blob:";
    expect(contentSecurityPolicy({ nonce: 'n1', production: true })).toBe(expected);
  });

  it("adds 'unsafe-eval' outside production for next dev's eval devtool", () => {
    const policy = contentSecurityPolicy({ nonce: 'n1', production: false });

    expect(scriptSrc(policy)).toBe("script-src 'self' 'nonce-n1' 'unsafe-eval'");
  });

  it('allows no third-party origin except the Steam avatar hosts, and only for images', () => {
    const policy = contentSecurityPolicy({ nonce: 'n1', production: true });
    const withoutImages = policy
      .split('; ')
      .filter((directive) => !directive.startsWith('img-src '))
      .join('; ');
    expect(withoutImages).not.toMatch(/https?:/);
  });
});

describe('createNonce', () => {
  it('returns a fresh base64 value on every call', () => {
    const first = createNonce();
    const second = createNonce();

    expect(first).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(first.length).toBeGreaterThanOrEqual(22);
    expect(first).not.toBe(second);
  });
});
