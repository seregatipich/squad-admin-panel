import { Writable } from 'node:stream';

const WEBHOOK_TOKEN_PATTERN =
  /(https?:\/\/(?:[a-z0-9-]+\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/\d+\/)[A-Za-z0-9_.-]+/gi;

const REDACTED_TOKEN = '****';

export function redactDiscordSecrets(input: string): string {
  return input.replace(WEBHOOK_TOKEN_PATTERN, `$1${REDACTED_TOKEN}`);
}

export function containsDiscordWebhookUrl(input: string): boolean {
  WEBHOOK_TOKEN_PATTERN.lastIndex = 0;
  return WEBHOOK_TOKEN_PATTERN.test(input);
}

interface WritableLike {
  write(chunk: string): unknown;
}

export function createDiscordRedactingStream(inner: WritableLike): Writable {
  return new Writable({
    write(chunk, _encoding, callback) {
      try {
        inner.write(redactDiscordSecrets(String(chunk)));
        callback();
      } catch (err) {
        callback(err as Error);
      }
    },
  });
}
