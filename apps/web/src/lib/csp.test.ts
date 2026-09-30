import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy, createNonce, isConfigsEditorPath } from './csp';

function scriptSrc(policy: string): string {
  return policy.split('; ').find((directive) => directive.startsWith('script-src ')) ?? '';
}

describe('contentSecurityPolicy', () => {
  // #60 finding 424: production `script-src` carried 'unsafe-inline', so any
  // injected <script> or onerror= handler would have run with operator rights.
  it("never allows inline scripts in production, only the request's nonce", () => {
    const policy = contentSecurityPolicy({
      nonce: 'abc123',
      pathname: '/dashboard',
      production: true,
    });

    expect(scriptSrc(policy)).toBe("script-src 'self' 'nonce-abc123'");
    expect(scriptSrc(policy)).not.toContain("'unsafe-inline'");
    expect(scriptSrc(policy)).not.toContain("'unsafe-eval'");
  });

  it('keeps the production base policy exact', () => {
    expect(contentSecurityPolicy({ nonce: 'n1', pathname: '/login', production: true })).toBe(
      "default-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; script-src 'self' 'nonce-n1'; style-src 'self' 'unsafe-inline'",
    );
  });

  it('adds only the Monaco directives on the config editor route', () => {
    expect(
      contentSecurityPolicy({ nonce: 'n1', pathname: '/servers/abc/configs', production: true }),
    ).toBe(
      "default-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; script-src 'self' 'nonce-n1'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self'",
    );
  });

  it("adds 'unsafe-eval' outside production for next dev's eval devtool", () => {
    const policy = contentSecurityPolicy({
      nonce: 'n1',
      pathname: '/dashboard',
      production: false,
    });

    expect(scriptSrc(policy)).toBe("script-src 'self' 'nonce-n1' 'unsafe-eval'");
  });

  it('allows no third-party origin anywhere', () => {
    for (const pathname of ['/dashboard', '/servers/abc/configs']) {
      const policy = contentSecurityPolicy({ nonce: 'n1', pathname, production: true });
      expect(policy).not.toMatch(/https?:/);
    }
  });
});

describe('isConfigsEditorPath', () => {
  it('matches only the config editor page', () => {
    expect(isConfigsEditorPath('/servers/abc/configs')).toBe(true);
    expect(isConfigsEditorPath('/servers/abc/configs/')).toBe(true);
    expect(isConfigsEditorPath('/servers/abc')).toBe(false);
    expect(isConfigsEditorPath('/servers/abc/configs/history')).toBe(false);
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
