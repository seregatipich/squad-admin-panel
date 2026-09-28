import { describe, expect, it } from 'vitest';
import { httpUrl, isSafeHttpUrl } from '../src/url.js';

describe('isSafeHttpUrl', () => {
  it('accepts http and https URLs', () => {
    expect(isSafeHttpUrl('https://example.com/clip')).toBe(true);
    expect(isSafeHttpUrl('http://example.com')).toBe(true);
  });

  it('rejects javascript: and data: URLs (#445)', () => {
    expect(isSafeHttpUrl('javascript:alert(document.cookie)')).toBe(false);
    expect(isSafeHttpUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
  });

  it('rejects a value that does not parse as a URL', () => {
    expect(isSafeHttpUrl('not a url')).toBe(false);
  });
});

describe('httpUrl', () => {
  const schema = httpUrl(2000);

  it('parses a valid https URL', () => {
    expect(schema.safeParse('https://example.com').success).toBe(true);
  });

  it('rejects a javascript: URL even though it is a well-formed URL', () => {
    const result = schema.safeParse('javascript:alert(1)');
    expect(result.success).toBe(false);
  });

  it('rejects a value past the max length', () => {
    const result = schema.safeParse(`https://example.com/${'a'.repeat(2000)}`);
    expect(result.success).toBe(false);
  });
});
