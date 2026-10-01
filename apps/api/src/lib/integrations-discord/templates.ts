/** Embed template schema and the stored-template views shared by the template and webhook routes. */

import type { DiscordMessageTemplateRow } from '@squad/db/schema';
import { type DiscordEmbedTemplate, defaultDiscordTemplate } from '@squad/shared-config';
import { z } from 'zod';

const embedFieldSchema = z.object({
  name: z.string().max(256),
  value: z.string().max(1024),
  inline: z.boolean(),
});

/** An embed template as accepted by the template routes and stored in the database. */
export const embedTemplateSchema = z.object({
  title: z.string().max(256),
  url: z.string().trim().max(2048).nullable().optional(),
  description: z.string().max(4096),
  color: z.number().int().min(0).max(0xffffff),
  fields: z.array(embedFieldSchema).max(25),
});

/**
 * The stored jsonb template, validated against the same schema the PUT route
 * enforces. A row that no longer fits (hand-edited, or written by an older
 * migration) falls back to the code default for its event type instead of
 * reaching `renderDiscordTemplate` as an arbitrary object; `null` when there
 * is no default either.
 */
export function storedTemplate(row: DiscordMessageTemplateRow): DiscordEmbedTemplate | null {
  const parsed = embedTemplateSchema.safeParse(row.template);
  if (parsed.success) return parsed.data;
  return defaultDiscordTemplate(row.eventType)?.template ?? null;
}

/** API view of a stored message template row. */
export function templateView(row: DiscordMessageTemplateRow) {
  return {
    event_type: row.eventType,
    locale: row.locale,
    template: storedTemplate(row),
    is_default: row.isDefault,
    updated_at: row.updatedAt.toISOString(),
  };
}
