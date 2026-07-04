const WEBHOOK_URL_PARTS = /\/webhooks\/(\d+)\/([A-Za-z0-9_.-]+)/;
const WEBHOOK_URL_VALIDATION =
  /^https?:\/\/(?:[a-z0-9-]+\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/\d+\/[A-Za-z0-9_.-]+$/i;

export const BOT_TOKEN_MASK = '****';

export function isDiscordWebhookUrl(url: string): boolean {
  return WEBHOOK_URL_VALIDATION.test(url);
}

export function maskWebhookUrl(url: string): string {
  const parts = url.match(WEBHOOK_URL_PARTS);
  const webhookId = parts?.[1];
  if (!webhookId) return '…/****';
  return `…/${webhookId.slice(0, 4)}…/****`;
}
