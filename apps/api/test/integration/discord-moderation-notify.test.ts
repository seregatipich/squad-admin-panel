import { discordWebhooks, playerReports, players, servers } from '@squad/db/schema';
import { STREAM_NAME } from '@squad/shared-types';
import pino from 'pino';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ensureConsumerGroup,
  NOTIFY_CONSUMER_GROUP,
  runNotifyLoop,
} from '../../../workers/discord/src/consume.js';
import { encrypt, serialize } from '../../src/lib/crypto.js';
import type { WorkerRconCommandOutcome } from '../../src/lib/rcon-worker-command.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './harness.js';

vi.mock('../../src/lib/rcon-worker-command.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/rcon-worker-command.js')>()),
  sendRconCommandViaWorker: vi.fn(),
}));

import { sendRconCommandViaWorker } from '../../src/lib/rcon-worker-command.js';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;
const TEST_KEY = Buffer.alloc(32, 0x42);
const OWNER_STEAM = testSteamId(956000);
const REPORTER_STEAM = testSteamId(956001);
const TARGET_STEAM = testSteamId(956002);
const silentLog = pino({ enabled: false });

let h: IntegrationHarness;
let serverId: string;
let reportId: string;

function okOutcome(): WorkerRconCommandOutcome {
  return {
    attempted: true,
    ok: true,
    requestId: 'discord-notify-rcon',
    response: 'ok',
    via: 'worker-rcon',
  } as WorkerRconCommandOutcome;
}

async function consumeAvailableEvent(stream: string, fetchImpl: typeof fetch): Promise<void> {
  let stop = false;
  await runNotifyLoop({
    redis: h.redis,
    db: h.db,
    encryptionKey: TEST_KEY,
    fetchImpl,
    sleep: async () => undefined,
    log: silentLog,
    panelBaseUrl: 'https://panel.test',
    blockMs: 50,
    shouldStop: () => stop,
    discoverStreams: async () => {
      stop = true;
      return [stream];
    },
  });
}

beforeAll(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM, canonicalName: 'Главный администратор' },
    bridge: makeFakeBridge(),
  });
  vi.mocked(sendRconCommandViaWorker).mockReset().mockResolvedValue(okOutcome());

  serverId = uuidv7();
  await h.db.insert(servers).values({
    id: serverId,
    displayName: 'Discord Notify Test',
    slug: `discord-notify-${serverId}`,
  });
  const [reporter, target] = await h.db
    .insert(players)
    .values([
      {
        steamId64: REPORTER_STEAM,
        canonicalName: 'Репортёр',
        canonicalNameNormalized: 'репортёр',
        eosId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
      {
        steamId64: TARGET_STEAM,
        canonicalName: 'Нарушитель',
        canonicalNameNormalized: 'нарушитель',
        eosId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      },
    ])
    .returning({ id: players.id });
  if (!reporter || !target) throw new Error('failed to seed Discord moderation players');

  const [report] = await h.db
    .insert(playerReports)
    .values({
      serverId,
      reporterPlayerId: reporter.id,
      targetPlayerId: target.id,
      targetRaw: 'Нарушитель',
      body: 'Нарушение правил',
      source: 'ui',
      status: 'pending',
    })
    .returning({ id: playerReports.id });
  if (!report) throw new Error('failed to seed Discord moderation report');
  reportId = report.id;
});

afterAll(async () => {
  await h.cleanup();
});

describeIfDb('UI moderation action → Discord notification', () => {
  it('delivers one ban embed to the enabled webhook, skips the disabled webhook, and deduplicates a replay', async () => {
    const enabledUrl = 'https://discord.test/webhooks/enabled';
    const disabledUrl = 'https://discord.test/webhooks/disabled';
    await h.db.insert(discordWebhooks).values([
      {
        id: uuidv7(),
        eventType: 'ban_issued',
        webhookUrlEncrypted: serialize(encrypt(TEST_KEY, enabledUrl)),
        channelLabel: 'enabled',
        enabled: true,
        mentionEveryone: false,
        serverId,
      },
      {
        id: uuidv7(),
        eventType: 'ban_issued',
        webhookUrlEncrypted: serialize(encrypt(TEST_KEY, disabledUrl)),
        channelLabel: 'disabled',
        enabled: false,
        mentionEveryone: false,
        serverId,
      },
    ]);

    const stream = STREAM_NAME.eventsServer(serverId);
    await ensureConsumerGroup(h.redis, stream, NOTIFY_CONSUMER_GROUP);
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    const startedAt = Date.now();

    const response = await h.app.inject({
      method: 'POST',
      url: `/api/v1/reports/${reportId}/actions`,
      headers: {
        cookie: await loginAsOwner(h),
        'content-type': 'application/json',
      },
      payload: JSON.stringify({
        action_type: 'ban',
        reason: 'Читы',
        ban_length: '7d',
      }),
    });
    expect(response.statusCode).toBe(200);

    await consumeAvailableEvent(stream, fetchMock as unknown as typeof fetch);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(enabledUrl);
    expect(url).not.toBe(disabledUrl);
    const payload = JSON.parse(init.body as string) as {
      embeds: Array<{
        title: string;
        description: string;
        fields: Array<{ name: string; value: string }>;
      }>;
    };
    expect(payload.embeds[0]).toMatchObject({
      title: 'Player banned',
      description: 'Нарушитель was banned on `Discord Notify Test`.',
    });
    expect(payload.embeds[0]?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Reason', value: 'Читы' }),
        expect.objectContaining({ name: 'Duration', value: '7d' }),
        expect.objectContaining({ name: 'Admin', value: 'Главный администратор' }),
      ]),
    );

    const entries = await h.redis.xrange(stream, '-', '+');
    const fields = entries[0]?.[1];
    if (!fields) throw new Error('moderation event was not written to the Redis stream');
    await h.redis.xadd(stream, '*', ...fields);
    await consumeAvailableEvent(stream, fetchMock as unknown as typeof fetch);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
