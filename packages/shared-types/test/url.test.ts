import { describe, expect, it } from 'vitest';
import { seedCallSentPayload } from '../src/events.js';
import { mediaLinkInput } from '../src/media.js';
import { httpUrl, httpUrlSchema, isSafeHttpUrl } from '../src/url.js';

describe('httpUrlSchema', () => {
  const schema = httpUrlSchema(2000);

  it('accepts http and https URLs', () => {
    expect(schema.safeParse('https://example.com/evidence.png').success).toBe(true);
    expect(schema.safeParse('http://example.com').success).toBe(true);
  });

  it('rejects javascript: and data: URLs', () => {
    expect(schema.safeParse('javascript:alert(1)').success).toBe(false);
    expect(schema.safeParse('data:text/html,<script>alert(1)</script>').success).toBe(false);
  });

  it('allows an extra protocol when explicitly opted in', () => {
    const withSteam = httpUrlSchema(512, ['http:', 'https:', 'steam:']);
    expect(withSteam.safeParse('steam://connect/10.0.0.1:27015').success).toBe(true);
    expect(withSteam.safeParse('javascript:alert(1)').success).toBe(false);
  });
});

describe('mediaLinkInput', () => {
  it('rejects a javascript: external_url instead of accepting any WHATWG URL', () => {
    const result = mediaLinkInput.safeParse({ external_url: 'javascript:alert(document.cookie)' });
    expect(result.success).toBe(false);
  });

  it('still accepts a legitimate https external_url', () => {
    const result = mediaLinkInput.safeParse({ external_url: 'https://clips.example.com/1' });
    expect(result.success).toBe(true);
  });
});

describe('seedCallSentPayload.join_link', () => {
  const base = {
    server_name: 'RU #1',
    seed_layer: null,
    scheduled_for: null,
    source: 'manual' as const,
    message: 'seed call',
  };

  it('accepts a steam:// join link', () => {
    const result = seedCallSentPayload.safeParse({
      ...base,
      join_link: 'steam://connect/10.0.0.1:27015',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a javascript: join link', () => {
    const result = seedCallSentPayload.safeParse({
      ...base,
      join_link: 'javascript:alert(1)',
    });
    expect(result.success).toBe(false);
  });
});

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
