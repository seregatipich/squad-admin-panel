import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { buildLogger } from '../src/lib/logger.js';

const WEBHOOK_TOKEN = 'Th1s_Is-A_FakeToken_ForTests_00112233445566778899aabbccddeeff';
const WEBHOOK_URL = `https://discord.com/api/webhooks/112233445566778899/${WEBHOOK_TOKEN}`;

function captureLogger() {
  let buffer = '';
  const sink = new Writable({
    write(chunk, _enc, cb) {
      buffer += String(chunk);
      cb();
    },
  });
  const { logger, lateSink } = buildLogger('info');
  lateSink.setInner(sink);
  return { logger, read: () => buffer };
}

describe('api logger redacts discord webhook secrets', () => {
  it('scrubs the token when a webhook url is logged on send', () => {
    const { logger, read } = captureLogger();
    logger.info({ url: WEBHOOK_URL }, 'discord webhook send');
    expect(read()).not.toContain(WEBHOOK_TOKEN);
    expect(read()).toContain('****');
  });

  it('scrubs the token on a forced error carrying the url in the message and stack', () => {
    const { logger, read } = captureLogger();
    logger.error({ err: new Error(`POST failed: ${WEBHOOK_URL}`) }, 'discord send failed');
    const out = read();
    expect(out).not.toContain(WEBHOOK_TOKEN);
    expect(out).not.toContain(WEBHOOK_URL);
  });
});
