import type { DatabaseClient } from '@squad/db';
import { discordMessageTemplates, discordWebhooks, servers } from '@squad/db/schema';
import {
  type DiscordEmbedTemplate,
  defaultDiscordTemplate,
  renderDiscordTemplate,
} from '@squad/shared-config';
import type { EventEnvelope } from '@squad/shared-types';
import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import { decryptString, deserialize } from './crypto.js';
import { buildTemplateContext, mapEventToDiscordType } from './mapping.js';

/** Hard ceiling on non-429 delivery attempts (network error or non-2xx status) per webhook. */
const MAX_SEND_ATTEMPTS = 5;
/** Hard ceiling on consecutive 429 retries per webhook, so a permanently-throttled webhook still gives up. */
const MAX_RATE_LIMIT_RETRIES = 5;
const BASE_BACKOFF_MS = 500;
/** Fallback wait when a 429 response carries no parseable `retry_after`/`Retry-After`. */
const DEFAULT_RATE_LIMIT_WAIT_MS = 1000;

export interface SenderDeps {
  db: DatabaseClient;
  encryptionKey: Buffer;
  /** Injected so tests can substitute a fake without touching the network. */
  fetchImpl: typeof fetch;
  /** Injected so retry-delay tests don't have to wait in real time. */
  sleep: (ms: number) => Promise<void>;
  log: Logger;
  /** Used to build `{player_url}` links; `null` disables them. */
  panelBaseUrl: string | null;
}

export interface DeliveryResult {
  /** Webhooks the embed was successfully POSTed to (2xx, after any retries). */
  sent: number;
  /** Webhooks that never got the embed after exhausting all retries. */
  failed: number;
  /** Webhooks that hit at least one 429 while being delivered (whether or not they eventually succeeded). */
  rateLimited: number;
}

function backoffMs(attempt: number): number {
  return BASE_BACKOFF_MS * 2 ** (attempt - 1);
}

/** Reads Discord's rate-limit wait out of a 429 response: `Retry-After` header (seconds) first, then a JSON `retry_after` body field (seconds). */
async function readRetryAfterMs(res: Response): Promise<number> {
  const header = res.headers.get('retry-after');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  }
  try {
    const body = (await res.clone().json()) as { retry_after?: unknown };
    if (typeof body.retry_after === 'number' && Number.isFinite(body.retry_after)) {
      return Math.max(0, body.retry_after) * 1000;
    }
  } catch {
    // no/invalid JSON body — fall through to the default wait
  }
  return DEFAULT_RATE_LIMIT_WAIT_MS;
}

interface WebhookPayload {
  content?: string;
  embeds: [DiscordEmbedTemplate];
  allowed_mentions?: { parse: string[] };
}

function buildPayload(embed: DiscordEmbedTemplate, mentionEveryone: boolean): WebhookPayload {
  const payload: WebhookPayload = { embeds: [embed] };
  if (mentionEveryone) {
    payload.content = '@everyone';
    payload.allowed_mentions = { parse: ['everyone'] };
  }
  return payload;
}

/**
 * POSTs one rendered embed to one webhook URL. 429 responses wait for
 * Discord's advertised retry delay and are retried without counting against
 * `MAX_SEND_ATTEMPTS` (capped separately by `MAX_RATE_LIMIT_RETRIES` so a
 * webhook stuck in a 429 loop still eventually gives up); any other
 * non-2xx status or a network error counts as a normal attempt with
 * exponential backoff. Never throws — callers get `{ok:false}` instead.
 */
async function postWebhook(
  deps: SenderDeps,
  url: string,
  payload: WebhookPayload,
): Promise<{ ok: boolean; rateLimited: boolean }> {
  let attempt = 0;
  let rateLimitRetries = 0;
  let rateLimited = false;

  for (;;) {
    let res: Response;
    try {
      res = await deps.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      attempt++;
      if (attempt >= MAX_SEND_ATTEMPTS) {
        deps.log.error(
          { err: (err as Error).message },
          'discord webhook post failed (network, giving up)',
        );
        return { ok: false, rateLimited };
      }
      await deps.sleep(backoffMs(attempt));
      continue;
    }

    if (res.status === 429) {
      rateLimited = true;
      rateLimitRetries++;
      if (rateLimitRetries > MAX_RATE_LIMIT_RETRIES) {
        deps.log.error('discord webhook post gave up after repeated 429 rate limiting');
        return { ok: false, rateLimited };
      }
      await deps.sleep(await readRetryAfterMs(res));
      continue;
    }

    if (res.ok) return { ok: true, rateLimited };

    attempt++;
    if (attempt >= MAX_SEND_ATTEMPTS) {
      deps.log.error({ status: res.status }, 'discord webhook post failed (status, giving up)');
      return { ok: false, rateLimited };
    }
    await deps.sleep(backoffMs(attempt));
  }
}

async function resolveServerName(
  deps: SenderDeps,
  serverId: string | null,
): Promise<string | null> {
  if (!serverId) return null;
  const rows = await deps.db
    .select({ displayName: servers.displayName })
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1);
  return rows[0]?.displayName ?? null;
}

async function resolveTemplate(
  deps: SenderDeps,
  discordType: string,
): Promise<DiscordEmbedTemplate | null> {
  const rows = await deps.db
    .select()
    .from(discordMessageTemplates)
    .where(eq(discordMessageTemplates.eventType, discordType))
    .limit(1);
  const row = rows[0];
  if (row) return row.template as DiscordEmbedTemplate;
  const fallback = defaultDiscordTemplate(discordType);
  return fallback?.template ?? null;
}

/**
 * Delivers one event-bus envelope to every enabled Discord webhook
 * subscribed to its mapped event type. A webhook whose `server_id` is set
 * only fires for that exact server; a `server_id IS NULL` webhook fires for
 * every server (and for server-less envelopes). Each webhook is delivered
 * independently — one webhook's failure (after retries) never blocks
 * delivery to another. Returns per-webhook counters; never throws for a
 * per-webhook delivery failure (only a DB error propagates, so the caller's
 * dedup/ack bookkeeping can tell "no webhooks matched" apart from "the DB
 * lookup itself failed").
 */
export async function deliverEnvelope(
  deps: SenderDeps,
  envelope: EventEnvelope,
): Promise<DeliveryResult> {
  const result: DeliveryResult = { sent: 0, failed: 0, rateLimited: 0 };
  const discordType = mapEventToDiscordType(envelope.type);
  if (!discordType) return result;

  // Filtered entirely in JS rather than in the WHERE clause: discord_webhooks
  // is a small operator-configured table (dozens of rows at most), and doing
  // the eventType/enabled/server_id match here keeps the query trivial to
  // unit-test without a real database.
  const rows = await deps.db.select().from(discordWebhooks);
  const candidates = rows.filter(
    (row) =>
      row.eventType === discordType &&
      row.enabled &&
      (row.serverId === null || row.serverId === envelope.server_id),
  );
  if (candidates.length === 0) return result;

  const [serverName, template] = await Promise.all([
    resolveServerName(deps, envelope.server_id),
    resolveTemplate(deps, discordType),
  ]);
  if (!template) {
    deps.log.error({ discordType }, 'no template (stored or default) for discord event type');
    result.failed = candidates.length;
    return result;
  }

  const missing: string[] = [];
  const context = buildTemplateContext({ envelope, serverName, panelBaseUrl: deps.panelBaseUrl });
  const embed = renderDiscordTemplate(template, context, {
    onMissingPlaceholder: (placeholder) => {
      if (!missing.includes(placeholder)) missing.push(placeholder);
    },
  });
  if (missing.length > 0) {
    deps.log.warn({ discordType, missing }, 'discord template referenced unfilled placeholders');
  }

  for (const row of candidates) {
    try {
      const url = decryptString(
        deps.encryptionKey,
        deserialize(Buffer.from(row.webhookUrlEncrypted as unknown as Buffer)),
      );
      const outcome = await postWebhook(deps, url, buildPayload(embed, row.mentionEveryone));
      if (outcome.rateLimited) result.rateLimited++;
      if (outcome.ok) result.sent++;
      else result.failed++;
    } catch (err) {
      result.failed++;
      deps.log.error(
        { webhookId: row.id, err: (err as Error).message },
        'discord webhook delivery threw',
      );
    }
  }

  return result;
}
