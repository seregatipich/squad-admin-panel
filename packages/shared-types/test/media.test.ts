import { describe, expect, it } from 'vitest';
import { externalMediaUrl, mediaLinkInput } from '../src/media.js';

describe('externalMediaUrl', () => {
  it('accepts http and https URLs', () => {
    expect(externalMediaUrl.safeParse('https://clips.example.com/a').success).toBe(true);
    expect(externalMediaUrl.safeParse('http://clips.example.com/a').success).toBe(true);
  });

  it.each(['javascript:alert(1)', 'data:text/html,<b>x</b>', 'file:///etc/passwd', 'not-a-url'])(
    'rejects %s without throwing',
    (value) => {
      expect(externalMediaUrl.safeParse(value).success).toBe(false);
    },
  );

  it('is the external_url schema of mediaLinkInput', () => {
    expect(mediaLinkInput.safeParse({ external_url: 'javascript:alert(1)' }).success).toBe(false);
  });
});
