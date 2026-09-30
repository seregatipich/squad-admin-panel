import { isDiscordWebhookUrl } from '@squad/shared-config/discord-template';

const WEBHOOK_URL_PARTS = /\/webhooks\/(\d+)\/([A-Za-z0-9_.-]+)/;
export const BOT_TOKEN_MASK = '****';

export function maskWebhookUrl(url: string): string {
  const parts = url.match(WEBHOOK_URL_PARTS);
  const webhookId = parts?.[1];
  if (!webhookId) return '…/****';
  return `…/${webhookId.slice(0, 4)}…/****`;
}

export { isDiscordWebhookUrl };
