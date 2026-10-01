/** Permission key and event-type schema shared by the Discord integration route modules. */

import { isDiscordEventType } from '@squad/db/schema';
import { z } from 'zod';

/** Permission every Discord integration route requires. */
export const INTEGRATION_PERMISSION = 'integration:manage' as const;

/** A known Discord event type. */
export const eventTypeSchema = z
  .string()
  .refine(isDiscordEventType, { message: 'unknown event type' });
