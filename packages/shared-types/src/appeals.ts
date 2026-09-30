import { z } from 'zod';

/** Lifecycle statuses of a ban appeal, as returned by `GET /api/v1/appeals`. */
export const appealStatusSchema = z.enum(['pending', 'in_review', 'approved', 'rejected']);

/** One appeal row of the moderation queue (`GET /api/v1/appeals`). */
export const appealItemSchema = z.object({
  id: z.string(),
  number: z.number().int(),
  status: appealStatusSchema,
  steam_id64: z.string(),
  body: z.string(),
  contact: z.string().nullable(),
  decision_note: z.string().nullable(),
  internal_note: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  decided_at: z.string().nullable(),
  player: z
    .object({ id: z.string(), name: z.string().nullable(), steam_id64: z.string().nullable() })
    .nullable(),
  moderation_action: z
    .object({
      id: z.string(),
      action_type: z.string().nullable(),
      reason: z.string().nullable(),
      created_at: z.string(),
      ban_length: z.string().nullable(),
    })
    .nullable(),
  handler: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
});

/** Paginated response of `GET /api/v1/appeals`. */
export const appealListResponseSchema = z.object({
  items: z.array(appealItemSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int(),
  page_size: z.number().int(),
});

/** Error body shared by the appeals routes; only a string `error` code is trusted. */
export const appealErrorResponseSchema = z.object({ error: z.string() });

export type AppealItem = z.infer<typeof appealItemSchema>;
export type AppealListResponse = z.infer<typeof appealListResponseSchema>;
