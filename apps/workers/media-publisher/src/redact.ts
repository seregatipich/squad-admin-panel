/** Placeholder substituted for any secret found in an outbound error string. */
export const REDACTION = '[redacted]';

/**
 * Removes known secret values from a string.
 *
 * Errors from `fetch` routinely embed the full request URL, and the Telegram
 * Bot API's URL *is* the bot token (`/bot<token>/sendVideo`); Google's error
 * bodies can echo a rejected credential back. Those strings end up in
 * `media_publications.error`, in worker logs and in diag events, so every
 * message leaving a publisher is scrubbed rather than trusted.
 *
 * Short values are ignored: a one- or two-character "secret" would match
 * everywhere and redact the whole message into noise.
 */
export function redactSecrets(message: string, secrets: (string | undefined)[]): string {
  let out = message;
  for (const secret of secrets) {
    if (!secret || secret.length < 8) continue;
    out = out.split(secret).join(REDACTION);
  }
  return out;
}
