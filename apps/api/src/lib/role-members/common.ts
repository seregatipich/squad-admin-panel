/** Schema and limit shared by the role member route modules. */

import { z } from 'zod';

/** Longest member comment, in characters, accepted by a single add or a CSV import row. */
export const COMMENT_MAX_LEN = 512;

/** Route params of the role member routes keyed by role id. */
export const roleIdParam = z.object({ id: z.string().uuid() });
