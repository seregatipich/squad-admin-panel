import { describe, expect, it } from 'vitest';
import { seedCallSentPayload } from '../src/events.js';
import { mediaLinkInput } from '../src/media.js';
import { httpUrlSchema } from '../src/url.js';

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
