import { sql } from 'drizzle-orm';

/**
 * Renders a uuid list as ONE bind parameter (`= ANY(<param>::uuid[])`),
 * so a large list never approaches Postgres' 65 535 bind-parameter limit the
 * way `IN (${a}, ${b}, …)` does.
 *
 * @param ids - Player (or other) uuids; must be valid uuid strings.
 * @returns A SQL fragment usable as the right-hand side of `col = ANY(...)`.
 */
export function uuidArrayParam(ids: readonly string[]) {
  return sql`string_to_array(${ids.join(',')}::text, ',')::uuid[]`;
}
