import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  containsDiscordWebhookUrl,
  createDiscordRedactingStream,
  redactDiscordSecrets,
} from '../src/discord-redaction.js';

const WEBHOOK_TOKEN = 'aB3d_Ef-9Zk0LmNoPqRsTuVwXyZ1234567890abcdefGHIJKLMNOPqrstuvwx';
const WEBHOOK_URL = `https://discord.com/api/webhooks/123456789012345678/${WEBHOOK_TOKEN}`;

describe('redactDiscordSecrets', () => {
  it('replaces the token segment with a mask while keeping the id', () => {
    const out = redactDiscordSecrets(`sending to ${WEBHOOK_URL} now`);
    expect(out).toContain('https://discord.com/api/webhooks/123456789012345678/****');
    expect(out).not.toContain(WEBHOOK_TOKEN);
    expect(out).not.toContain(WEBHOOK_URL);
  });

  it('redacts versioned api paths and discordapp.com host', () => {
    const versioned = `https://discordapp.com/api/v10/webhooks/987654321098765432/${WEBHOOK_TOKEN}`;
    const out = redactDiscordSecrets(versioned);
    expect(out).not.toContain(WEBHOOK_TOKEN);
    expect(out).toContain('webhooks/987654321098765432/****');
  });

  it('redacts multiple occurrences in one string', () => {
    const out = redactDiscordSecrets(`${WEBHOOK_URL} and ${WEBHOOK_URL}`);
    expect(out).not.toContain(WEBHOOK_TOKEN);
    expect(out.match(/\*\*\*\*/g)?.length).toBe(2);
  });

  it('leaves unrelated strings untouched', () => {
    expect(redactDiscordSecrets('nothing secret here')).toBe('nothing secret here');
  });

  it('containsDiscordWebhookUrl detects the pattern', () => {
    expect(containsDiscordWebhookUrl(WEBHOOK_URL)).toBe(true);
    expect(containsDiscordWebhookUrl('https://example.com/foo')).toBe(false);
  });
});

describe('createDiscordRedactingStream', () => {
  function capture(): { stream: Writable; read: () => string } {
    let buffer = '';
    const inner = new Writable({
      write(chunk, _enc, cb) {
        buffer += String(chunk);
        cb();
      },
    });
    return { stream: createDiscordRedactingStream(inner), read: () => buffer };
  }

  it('scrubs a serialized log line containing a webhook url in a message', () => {
    const sink = capture();
    sink.stream.write(`${JSON.stringify({ level: 30, msg: `send ${WEBHOOK_URL}` })}\n`);
    expect(sink.read()).not.toContain(WEBHOOK_TOKEN);
    expect(sink.read()).toContain('****');
  });

  it('scrubs the url embedded in a serialized error stack', () => {
    const sink = capture();
    const errLine = JSON.stringify({
      level: 50,
      err: { message: `fetch failed ${WEBHOOK_URL}`, stack: `Error: boom ${WEBHOOK_URL}` },
      msg: 'discord send failed',
    });
    sink.stream.write(`${errLine}\n`);
    const out = sink.read();
    expect(out).not.toContain(WEBHOOK_TOKEN);
    expect(out).not.toContain(WEBHOOK_URL);
  });

  it('forwards unrelated lines unchanged', () => {
    const sink = capture();
    sink.stream.write('{"level":30,"msg":"nothing to hide"}\n');
    expect(sink.read()).toBe('{"level":30,"msg":"nothing to hide"}\n');
  });

  it('propagates an inner write error to the stream callback', async () => {
    const stream = createDiscordRedactingStream({
      write() {
        throw new Error('inner boom');
      },
    });
    stream.on('error', () => {});
    const err = await new Promise<Error | null | undefined>((resolve) => {
      stream.write('x', (e) => resolve(e));
    });
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('inner boom');
  });
});
