/** Request schemas of the issue tracker routes. */

import { ISSUE_LINK_ENTITY_TYPES } from '@squad/db/schema';
import { z } from 'zod';

const TITLE_MAX = 200;
const BODY_MAX = 4000;
const PER_PAGE_DEFAULT = 20;
const PER_PAGE_MAX = 100;

const MAX_LINKS_PER_CREATE = 20;

const stateSchema = z.enum(['open', 'in_progress', 'closed']);
const labelNamesSchema = z.array(z.string().trim().min(1).max(64)).max(20);
/** One ticket-to-entity link in a create or add-link body. */
export const linkInput = z.object({
  entity_type: z.enum(ISSUE_LINK_ENTITY_TYPES),
  entity_id: z.string().uuid(),
});

/** Body of `POST /api/v1/issues`. */
export const createBody = z.object({
  title: z.string().trim().min(1).max(TITLE_MAX),
  body: z.string().trim().min(1).max(BODY_MAX),
  labels: labelNamesSchema.optional(),
  links: z.array(linkInput).max(MAX_LINKS_PER_CREATE).optional(),
});

/** Body of `PATCH /api/v1/issues/:id`; at least one field is required. */
export const patchBody = z
  .object({
    title: z.string().trim().min(1).max(TITLE_MAX).optional(),
    body: z.string().trim().min(1).max(BODY_MAX).optional(),
    labels: labelNamesSchema.optional(),
    assignee_player_id: z.string().uuid().nullable().optional(),
    state: stateSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'empty_update' });

/** Body of `POST /api/v1/issues/:id/comments`. */
export const commentBody = z.object({
  body: z.string().trim().min(1).max(BODY_MAX),
});

/** Query of `GET /api/v1/issues`. */
export const listQuery = z.object({
  state: stateSchema.optional(),
  label: z.string().trim().min(1).max(64).optional(),
  assignee: z.string().uuid().optional(),
  q: z.string().trim().min(1).max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(PER_PAGE_MAX).default(PER_PAGE_DEFAULT),
});

/** Route params keyed by issue id. */
export const idParam = z.object({ id: z.string().uuid() });
/** Route params keyed by issue id and link id. */
export const linkIdParam = z.object({ id: z.string().uuid(), linkId: z.string().uuid() });
/** Route params keyed by player id. */
export const playerIdParam = z.object({ playerId: z.string().uuid() });
