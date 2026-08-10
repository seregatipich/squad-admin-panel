import { describe, expect, it, vi } from 'vitest';
import {
  createTelegramPublisher,
  TELEGRAM_MAX_UPLOAD_BYTES,
  telegramMessageUrl,
} from '../src/publishers/telegram.js';
import type { MediaPublicationJob } from '../src/tick.js';

const BOT_TOKEN = '1234567:AAHfake-telegram-bot-token-value';
const CHAT_ID = '-1001234567890';

function makeJob(overrides: Partial<MediaPublicationJob> = {}): MediaPublicationJob {
  return {
    id: '018f0000-0000-7000-8000-000000000001',
    mediaId: '018f0000-0000-7000-8000-0000000000aa',
    destination: 'telegram',
    attempts: 0,
    storagePath: '2026/07/clip.mp4',
    mimeType: 'video/mp4',
    sizeBytes: 1024,
    title: 'Нарушение на Yehorivka',
    description: null,
    originalFilename: 'clip.mp4',
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makePublisher(
  fetchImpl: typeof fetch,
  overrides: Partial<Parameters<typeof createTelegramPublisher>[0]> = {},
) {
  const publisher = createTelegramPublisher({
    botToken: BOT_TOKEN,
    chatId: CHAT_ID,
    mediaBaseDir: '/srv/media',
    fetch: fetchImpl,
    readMedia: async () => new Uint8Array([1, 2, 3, 4]),
    ...overrides,
  });
  if (!publisher) throw new Error('expected a configured telegram publisher');
  return publisher;
}

describe('createTelegramPublisher — configuration gate', () => {
  it('returns null when the bot token is absent', () => {
    expect(createTelegramPublisher({ chatId: CHAT_ID, mediaBaseDir: '/srv/media' })).toBeNull();
  });

  it('returns null when the chat id is absent', () => {
    expect(createTelegramPublisher({ botToken: BOT_TOKEN, mediaBaseDir: '/srv/media' })).toBeNull();
  });

  it('returns a publisher when both credentials are present', () => {
    expect(
      createTelegramPublisher({
        botToken: BOT_TOKEN,
        chatId: CHAT_ID,
        mediaBaseDir: '/srv/media',
      }),
    ).toBeTypeOf('function');
  });
});

describe('telegramMessageUrl', () => {
  it('builds a public channel url from an @username chat id', () => {
    expect(telegramMessageUrl('@squad_bans', 42)).toBe('https://t.me/squad_bans/42');
  });

  it('builds a private supergroup url from a -100-prefixed chat id', () => {
    expect(telegramMessageUrl('-1001234567890', 42)).toBe('https://t.me/c/1234567890/42');
  });

  it('returns null for a chat id with no addressable public form', () => {
    expect(telegramMessageUrl('987654321', 42)).toBeNull();
    expect(telegramMessageUrl('-987654321', 42)).toBeNull();
  });
});

describe('createTelegramPublisher — publishing', () => {
  it('uploads a video with sendVideo and returns the message id and url', async () => {
    const calls: string[] = [];
    const publisher = makePublisher(async (input) => {
      calls.push(String(input));
      return jsonResponse(200, { ok: true, result: { message_id: 77 } });
    });

    const outcome = await publisher(makeJob());

    expect(outcome).toEqual({
      ok: true,
      externalId: '77',
      externalUrl: 'https://t.me/c/1234567890/77',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(`https://api.telegram.org/bot${BOT_TOKEN}/sendVideo`);
  });

  it('uploads an image with sendPhoto', async () => {
    const calls: string[] = [];
    const publisher = makePublisher(async (input) => {
      calls.push(String(input));
      return jsonResponse(200, { ok: true, result: { message_id: 5 } });
    });

    const outcome = await publisher(
      makeJob({ mimeType: 'image/png', storagePath: '2026/07/a.png' }),
    );

    expect(outcome.ok).toBe(true);
    expect(calls[0]).toContain('/sendPhoto');
  });

  it('reads the file from the configured media base dir joined with the storage path', async () => {
    const readMedia = vi.fn(async () => new Uint8Array([9]));
    const publisher = makePublisher(
      async () => jsonResponse(200, { ok: true, result: { message_id: 1 } }),
      { readMedia },
    );

    await publisher(makeJob({ storagePath: '2026/07/clip.mp4' }));

    expect(readMedia).toHaveBeenCalledWith('/srv/media/2026/07/clip.mp4');
  });

  it('succeeds with a null url when the chat id has no addressable public form', async () => {
    const publisher = makePublisher(
      async () => jsonResponse(200, { ok: true, result: { message_id: 3 } }),
      { chatId: '987654321' },
    );

    const outcome = await publisher(makeJob());

    expect(outcome).toEqual({ ok: true, externalId: '3', externalUrl: null });
  });
});

describe('createTelegramPublisher — failure classification', () => {
  it('rejects a file above the Telegram bot upload ceiling without calling the API', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { ok: true, result: { message_id: 1 } }));
    const publisher = makePublisher(fetchImpl as unknown as typeof fetch);

    const outcome = await publisher(makeJob({ sizeBytes: TELEGRAM_MAX_UPLOAD_BYTES + 1 }));

    expect(outcome).toEqual({
      ok: false,
      retryable: false,
      error: 'telegram_file_too_large',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a media row that has no local file to upload', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { ok: true, result: { message_id: 1 } }));
    const publisher = makePublisher(fetchImpl as unknown as typeof fetch);

    const outcome = await publisher(makeJob({ storagePath: null }));

    expect(outcome).toEqual({ ok: false, retryable: false, error: 'no_local_file' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('treats HTTP 429 as retryable and honours the retry_after hint', async () => {
    const publisher = makePublisher(async () =>
      jsonResponse(429, {
        ok: false,
        description: 'Too Many Requests: retry after 30',
        parameters: { retry_after: 30 },
      }),
    );

    const outcome = await publisher(makeJob());

    expect(outcome).toMatchObject({ ok: false, retryable: true, retryAfterMs: 30_000 });
  });

  it('treats HTTP 5xx as retryable', async () => {
    const publisher = makePublisher(async () => jsonResponse(502, { ok: false }));

    const outcome = await publisher(makeJob());

    expect(outcome).toMatchObject({ ok: false, retryable: true });
  });

  it('treats a client error as permanent', async () => {
    const publisher = makePublisher(async () =>
      jsonResponse(400, { ok: false, description: 'Bad Request: chat not found' }),
    );

    const outcome = await publisher(makeJob());

    expect(outcome).toMatchObject({ ok: false, retryable: false });
  });

  it('treats a transport failure as retryable', async () => {
    const publisher = makePublisher(async () => {
      throw new Error('ECONNRESET');
    });

    const outcome = await publisher(makeJob());

    expect(outcome).toMatchObject({ ok: false, retryable: true });
  });
});

describe('createTelegramPublisher — secret hygiene', () => {
  it('never leaks the bot token in an error string', async () => {
    const publisher = makePublisher(async () => {
      // The real failure mode: node's fetch puts the full request URL — which
      // embeds the bot token — into the thrown error message.
      throw new Error(`request to https://api.telegram.org/bot${BOT_TOKEN}/sendVideo failed`);
    });

    const outcome = await publisher(makeJob());

    expect(outcome.ok).toBe(false);
    const serialized = JSON.stringify(outcome);
    expect(serialized).not.toContain(BOT_TOKEN);
    expect(serialized).toContain('[redacted]');
  });

  it('never leaks the bot token when the API echoes it back in a description', async () => {
    const publisher = makePublisher(async () =>
      jsonResponse(400, { ok: false, description: `token ${BOT_TOKEN} is invalid` }),
    );

    const outcome = await publisher(makeJob());

    expect(JSON.stringify(outcome)).not.toContain(BOT_TOKEN);
  });
});
