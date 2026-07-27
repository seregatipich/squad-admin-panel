import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { redactSecrets } from '../redact.js';
import type { MediaPublisher, PublishOutcome } from '../tick.js';

/**
 * Hard ceiling the Telegram Bot API puts on an uploaded file (50 MiB), against
 * the panel's own 2 GiB media cap. There is no chunked path for bots, so a
 * larger file is rejected permanently rather than retried forever — the
 * operator's fallback is YouTube, whose resumable upload has no such limit.
 */
export const TELEGRAM_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export interface TelegramPublisherConfig {
  botToken?: string;
  chatId?: string;
  mediaBaseDir: string;
  fetch?: typeof fetch;
  readMedia?: (absolutePath: string) => Promise<Uint8Array>;
}

/**
 * Builds the public URL of a posted message.
 *
 * Only two chat-id forms are addressable: an `@username` channel and a
 * `-100…` supergroup/channel id. Anything else (a legacy group, a private
 * chat) has no `t.me` link at all, and returning `null` is deliberate — a
 * fabricated URL would be stored as `external_url` and could then be used to
 * justify deleting the local file.
 */
export function telegramMessageUrl(chatId: string, messageId: number): string | null {
  if (chatId.startsWith('@')) {
    const name = chatId.slice(1);
    return name ? `https://t.me/${name}/${messageId}` : null;
  }
  if (chatId.startsWith('-100')) {
    const internal = chatId.slice(4);
    return /^\d+$/.test(internal) ? `https://t.me/c/${internal}/${messageId}` : null;
  }
  return null;
}

interface TelegramResponse {
  ok?: boolean;
  description?: string;
  result?: { message_id?: number };
  parameters?: { retry_after?: number };
}

/**
 * Creates a Telegram publisher, or `null` when the bot credentials are absent.
 *
 * The `null` return is the configuration gate the whole feature hangs on
 * (mirroring `fetchSteamProfile`'s `if (!deps.apiKey) return null`): the worker
 * defers publications for a destination it cannot reach instead of failing
 * them, so enabling Telegram later drains the backlog rather than finding it
 * dead.
 */
export function createTelegramPublisher(config: TelegramPublisherConfig): MediaPublisher | null {
  const { botToken, chatId } = config;
  if (!botToken || !chatId) return null;

  const doFetch = config.fetch ?? fetch;
  const readMedia = config.readMedia ?? ((absolutePath: string) => readFile(absolutePath));
  const scrub = (message: string): string => redactSecrets(message, [botToken]);

  return async (job): Promise<PublishOutcome> => {
    if (!job.storagePath) return { ok: false, retryable: false, error: 'no_local_file' };
    if (job.sizeBytes > TELEGRAM_MAX_UPLOAD_BYTES) {
      return { ok: false, retryable: false, error: 'telegram_file_too_large' };
    }

    const isVideo = job.mimeType.startsWith('video/');
    const method = isVideo ? 'sendVideo' : 'sendPhoto';
    const field = isVideo ? 'video' : 'photo';
    const absolutePath = path.join(config.mediaBaseDir, job.storagePath);

    let response: Response;
    try {
      const bytes = await readMedia(absolutePath);
      const form = new FormData();
      form.set('chat_id', chatId);
      form.set('caption', job.title ?? job.originalFilename);
      form.set(field, new Blob([bytes], { type: job.mimeType }), job.originalFilename);
      response = await doFetch(`https://api.telegram.org/bot${botToken}/${method}`, {
        method: 'POST',
        body: form,
      });
    } catch (err) {
      return {
        ok: false,
        retryable: true,
        error: scrub(`telegram_transport_error: ${(err as Error).message}`),
      };
    }

    let body: TelegramResponse = {};
    try {
      body = (await response.json()) as TelegramResponse;
    } catch {
      // A non-JSON body is only actionable through its status code.
    }

    if (response.status === 429) {
      const retryAfterSeconds = body.parameters?.retry_after;
      return {
        ok: false,
        retryable: true,
        error: 'telegram_rate_limited',
        ...(typeof retryAfterSeconds === 'number'
          ? { retryAfterMs: retryAfterSeconds * 1000 }
          : {}),
      };
    }
    if (response.status >= 500) {
      return { ok: false, retryable: true, error: `telegram_server_error_${response.status}` };
    }
    if (!response.ok || body.ok === false) {
      return {
        ok: false,
        retryable: false,
        error: scrub(`telegram_rejected: ${body.description ?? response.status}`),
      };
    }

    const messageId = body.result?.message_id;
    if (typeof messageId !== 'number') {
      return { ok: false, retryable: true, error: 'telegram_missing_message_id' };
    }

    return {
      ok: true,
      externalId: String(messageId),
      externalUrl: telegramMessageUrl(chatId, messageId),
    };
  };
}
