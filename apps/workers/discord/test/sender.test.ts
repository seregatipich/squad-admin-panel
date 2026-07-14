import { createCipheriv, randomBytes } from 'node:crypto';
import { discordMessageTemplates, discordWebhooks, servers } from '@squad/db/schema';
import type { EventEnvelope } from '@squad/shared-types';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { EncryptedBlob } from '../src/crypto.js';
import { deliverEnvelope, type SenderDeps } from '../src/sender.js';

const KEY = Buffer.alloc(32, 0x42);
const SERVER_A = '11111111-1111-1111-1111-111111111111';
const SERVER_B = '22222222-2222-2222-2222-222222222222';

function encryptUrl(url: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv, { authTagLength: 16 });
  const ct = Buffer.concat([cipher.update(url, 'utf-8'), cipher.final()]);
  const blob: EncryptedBlob = {
    v: 1,
    kv: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
  };
  return Buffer.from(JSON.stringify(blob), 'utf-8');
}

interface FakeWebhookRow {
  id: string;
  eventType: string;
  webhookUrlEncrypted: Buffer;
  enabled: boolean;
  mentionEveryone: boolean;
  serverId: string | null;
}

function webhookRow(overrides: Partial<FakeWebhookRow> & { url: string }): FakeWebhookRow {
  return {
    id: overrides.id ?? 'wh-1',
    eventType: overrides.eventType ?? 'server_crashed',
    webhookUrlEncrypted: encryptUrl(overrides.url),
    enabled: overrides.enabled ?? true,
    mentionEveryone: overrides.mentionEveryone ?? false,
    serverId: overrides.serverId ?? null,
  };
}

function makeFakeDb(opts: {
  webhookRows: FakeWebhookRow[];
  serverName?: string | null;
  templateRow?: { template: unknown } | null;
}) {
  return {
    select: (_fields?: unknown) => ({
      from: (table: unknown) => {
        if (table === discordWebhooks) {
          return Promise.resolve(opts.webhookRows);
        }
        if (table === servers) {
          return {
            where: () => ({
              limit: async () =>
                opts.serverName != null ? [{ displayName: opts.serverName }] : [],
            }),
          };
        }
        if (table === discordMessageTemplates) {
          return {
            where: () => ({
              limit: async () => (opts.templateRow ? [opts.templateRow] : []),
            }),
          };
        }
        throw new Error('unexpected table in fake db select().from()');
      },
    }),
    // biome-ignore lint/suspicious/noExplicitAny: minimal fake matching only what sender.ts calls
  } as any;
}

function envelope(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    event_id: '33333333-3333-3333-3333-333333333333',
    version: 1,
    type: 'server.crashed',
    server_id: SERVER_A,
    ts: '2026-07-14T00:00:00.000Z',
    actor: null,
    correlation_id: null,
    payload: { pid: 1, reason: 'oom', exit_code: 137 },
    ...overrides,
  };
}

const silentLog = pino({ enabled: false });

function makeDeps(overrides: Partial<SenderDeps> & { db: SenderDeps['db'] }): SenderDeps {
  return {
    encryptionKey: KEY,
    fetchImpl: vi.fn(),
    sleep: vi.fn(async () => undefined),
    log: silentLog,
    panelBaseUrl: null,
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown = {}, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

describe('deliverEnvelope', () => {
  it('does nothing for event types with no Discord mapping', async () => {
    const db = makeFakeDb({ webhookRows: [] });
    const fetchImpl = vi.fn();
    const result = await deliverEnvelope(
      makeDeps({ db, fetchImpl }),
      envelope({ type: 'player.connected' }),
    );
    expect(result).toEqual({ sent: 0, failed: 0, rateLimited: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sends exactly one POST with the rendered embed to a matching enabled webhook', async () => {
    const row = webhookRow({ url: 'https://discord.com/api/webhooks/1/aaa', serverId: null });
    const db = makeFakeDb({ webhookRows: [row], serverName: 'RU #1' });
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const result = await deliverEnvelope(makeDeps({ db, fetchImpl }), envelope());

    expect(result).toEqual({ sent: 1, failed: 0, rateLimited: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://discord.com/api/webhooks/1/aaa');
    const body = JSON.parse(init.body as string);
    expect(body.embeds).toHaveLength(1);
    expect(body.embeds[0].description).toContain('RU \\#1');
    expect(body.content).toBeUndefined();
  });

  it('does not deliver to a disabled webhook', async () => {
    const row = webhookRow({ url: 'https://discord.com/api/webhooks/1/aaa', enabled: false });
    const db = makeFakeDb({ webhookRows: [row] });
    const fetchImpl = vi.fn();
    const result = await deliverEnvelope(makeDeps({ db, fetchImpl }), envelope());
    expect(result).toEqual({ sent: 0, failed: 0, rateLimited: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a server-scoped webhook only fires for its own server', async () => {
    const scoped = webhookRow({
      id: 'wh-scoped',
      url: 'https://discord.com/api/webhooks/2/bbb',
      serverId: SERVER_B,
    });
    const db = makeFakeDb({ webhookRows: [scoped] });
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const result = await deliverEnvelope(
      makeDeps({ db, fetchImpl }),
      envelope({ server_id: SERVER_A }),
    );
    expect(result).toEqual({ sent: 0, failed: 0, rateLimited: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a NULL server_id webhook fires for every server', async () => {
    const global = webhookRow({ url: 'https://discord.com/api/webhooks/3/ccc', serverId: null });
    const db = makeFakeDb({ webhookRows: [global] });
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const result = await deliverEnvelope(
      makeDeps({ db, fetchImpl }),
      envelope({ server_id: SERVER_B }),
    );
    expect(result).toEqual({ sent: 1, failed: 0, rateLimited: 0 });
  });

  it('honors a 429 retry_after (JSON body) and delivers on the next attempt without loss', async () => {
    const row = webhookRow({ url: 'https://discord.com/api/webhooks/1/aaa' });
    const db = makeFakeDb({ webhookRows: [row] });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { retry_after: 0.2 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const sleep = vi.fn(async () => undefined);
    const result = await deliverEnvelope(makeDeps({ db, fetchImpl, sleep }), envelope());

    expect(result).toEqual({ sent: 1, failed: 0, rateLimited: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(200);
  });

  it('honors a 429 Retry-After header in seconds', async () => {
    const row = webhookRow({ url: 'https://discord.com/api/webhooks/1/aaa' });
    const db = makeFakeDb({ webhookRows: [row] });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { 'retry-after': '1' } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const sleep = vi.fn(async () => undefined);
    const result = await deliverEnvelope(makeDeps({ db, fetchImpl, sleep }), envelope());

    expect(result).toEqual({ sent: 1, failed: 0, rateLimited: 1 });
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it('gives up after 5 consecutive 500s and counts one failure, without throwing', async () => {
    const row = webhookRow({ url: 'https://discord.com/api/webhooks/1/aaa' });
    const db = makeFakeDb({ webhookRows: [row] });
    const fetchImpl = vi.fn(async () => new Response(null, { status: 500 }));
    const result = await deliverEnvelope(makeDeps({ db, fetchImpl }), envelope());

    expect(result).toEqual({ sent: 0, failed: 1, rateLimited: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  it('one webhook failing does not prevent delivery to a second webhook of the same event', async () => {
    const bad = webhookRow({ id: 'wh-bad', url: 'https://discord.com/api/webhooks/1/aaa' });
    const good = webhookRow({ id: 'wh-good', url: 'https://discord.com/api/webhooks/2/bbb' });
    const db = makeFakeDb({ webhookRows: [bad, good] });
    const fetchImpl = vi.fn(async (url: string | URL) => {
      if (String(url).includes('/1/aaa')) return new Response(null, { status: 500 });
      return new Response(null, { status: 204 });
    });
    const result = await deliverEnvelope(makeDeps({ db, fetchImpl }), envelope());

    expect(result).toEqual({ sent: 1, failed: 1, rateLimited: 0 });
  });

  it('falls back to the default template when no template row is stored', async () => {
    const row = webhookRow({ url: 'https://discord.com/api/webhooks/1/aaa' });
    const db = makeFakeDb({ webhookRows: [row], templateRow: null });
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const result = await deliverEnvelope(makeDeps({ db, fetchImpl }), envelope());
    expect(result.sent).toBe(1);
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.embeds[0].title).toBe('Server crashed');
  });

  it('escapes markdown characters in a context value substituted into the embed', async () => {
    const row = webhookRow({
      url: 'https://discord.com/api/webhooks/1/aaa',
      eventType: 'map_changed',
    });
    const db = makeFakeDb({ webhookRows: [row] });
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const result = await deliverEnvelope(
      makeDeps({ db, fetchImpl }),
      envelope({
        type: 'match.started',
        payload: { from_state: 'warmup', to_state: 'live', layer: '*Narva*_v1', game_mode: 'RAAS' },
      }),
    );
    expect(result.sent).toBe(1);
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    const mapField = body.embeds[0].fields.find((f: { name: string }) => f.name === 'Map');
    expect(mapField.value).toBe('\\*Narva\\*\\_v1');
  });

  it('mention_everyone adds @everyone content and allowed_mentions', async () => {
    const row = webhookRow({
      url: 'https://discord.com/api/webhooks/1/aaa',
      mentionEveryone: true,
    });
    const db = makeFakeDb({ webhookRows: [row] });
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    await deliverEnvelope(makeDeps({ db, fetchImpl }), envelope());
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.content).toBe('@everyone');
    expect(body.allowed_mentions).toEqual({ parse: ['everyone'] });
  });

  it('a persistent network error also gives up after 5 attempts and counts one failure', async () => {
    const row = webhookRow({ url: 'https://discord.com/api/webhooks/1/aaa' });
    const db = makeFakeDb({ webhookRows: [row] });
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const result = await deliverEnvelope(makeDeps({ db, fetchImpl }), envelope());
    expect(result).toEqual({ sent: 0, failed: 1, rateLimited: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });
});
