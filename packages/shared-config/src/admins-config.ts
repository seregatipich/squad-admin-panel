export const BEGIN_MARKER = '//SQUAD-PANEL BEGIN';
export const END_MARKER = '//SQUAD-PANEL END';
const BEGIN_LINE = `${BEGIN_MARKER} — не редактировать вручную`;
const SEGMENT_NEWLINE = '\r\n';

export interface RoleEntry {
  name: string;
  squadPermissions: string[];
}

export interface AdminEntry {
  eosId: string;
  roleName: string;
  comment?: string | null;
}

/** A clan member with `has_priority` on an active, unexpired clan. */
export interface ClanPriorityEntry {
  eosId: string;
  clanName: string;
}

export interface SegmentInputs {
  roles: RoleEntry[];
  admins: AdminEntry[];
  clanPriority?: ClanPriorityEntry[];
}

/**
 * Synthetic role name used to grant the `reserve` Squad permission to clan
 * members with an active priority slot (CLAN-4). If a real DB role happens
 * to be named `ClanPriority`, its own Group= line is used instead and the
 * synthetic one is skipped (see risk note in the CLAN-4 issue) — the Admin=
 * lines for clan-priority members are still emitted either way.
 */
export const CLAN_PRIORITY_GROUP_NAME = 'ClanPriority';
const CLAN_PRIORITY_PERMISSION = 'reserve';

/**
 * The byte-producing part of the managed segment: everything that is written
 * into Admins.cfg, without the sha256 idempotency hash (which needs
 * `node:crypto` and is therefore layered on top in a Node-only consumer). This
 * function is intentionally free of Node built-ins so the web panel can render
 * a byte-identical preview from the exact same code the config-sync worker uses
 * to write the file.
 */
export interface ManagedSegmentBody {
  body: string;
  groupsCount: number;
  adminsCount: number;
}

/**
 * Build the body of the //SQUAD-PANEL BEGIN/END managed segment from a
 * snapshot of the DB. Only roles with at least one Squad permission emit
 * a Group= line. Only admin entries whose role has at least one Squad
 * permission emit an Admin= line. The order is deterministic (sorted
 * alphabetically by role name then by eos_id) so a sha256 idempotency
 * check over the body is stable.
 *
 * `clanPriority` (CLAN-4) is appended after the role-derived groups/admins:
 * a constant `Group=ClanPriority:reserve` line (skipped if a real role is
 * already named `ClanPriority`, to avoid a duplicate Group= definition),
 * followed by one `Admin=<eosId>:ClanPriority // clan:<name>` line per
 * entry, sorted by eos_id.
 */
export function buildManagedSegmentBody(inputs: SegmentInputs): ManagedSegmentBody {
  const rolesWithPerms = inputs.roles
    .filter((r) => r.squadPermissions.length > 0)
    .map((r) => ({ ...r, squadPermissions: [...r.squadPermissions].sort() }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const validRoleNames = new Set(rolesWithPerms.map((r) => r.name));
  const admins = inputs.admins
    .filter((a) => validRoleNames.has(a.roleName))
    .sort((a, b) => {
      const r = a.roleName.localeCompare(b.roleName);
      if (r !== 0) return r;
      return a.eosId.localeCompare(b.eosId);
    });

  const clanPriority = inputs.clanPriority ?? [];
  const hasClanPriorityRole = validRoleNames.has(CLAN_PRIORITY_GROUP_NAME);
  const emitClanPriorityGroup = clanPriority.length > 0 && !hasClanPriorityRole;
  const clanAdmins = [...clanPriority].sort((a, b) => a.eosId.localeCompare(b.eosId));

  const totalGroups = rolesWithPerms.length + (emitClanPriorityGroup ? 1 : 0);
  const totalAdmins = admins.length + clanAdmins.length;

  const lines: string[] = [BEGIN_LINE];
  for (const role of rolesWithPerms) {
    lines.push(`Group=${role.name}:${role.squadPermissions.join(',')}`);
  }
  if (emitClanPriorityGroup) {
    lines.push(`Group=${CLAN_PRIORITY_GROUP_NAME}:${CLAN_PRIORITY_PERMISSION}`);
  }
  if (totalGroups > 0 && totalAdmins > 0) lines.push('');
  for (const admin of admins) {
    const base = `Admin=${admin.eosId}:${admin.roleName}`;
    lines.push(admin.comment ? `${base} // ${admin.comment}` : base);
  }
  for (const entry of clanAdmins) {
    lines.push(`Admin=${entry.eosId}:${CLAN_PRIORITY_GROUP_NAME} // clan:${entry.clanName}`);
  }
  lines.push(END_MARKER);

  return {
    body: lines.join(SEGMENT_NEWLINE),
    groupsCount: totalGroups,
    adminsCount: totalAdmins,
  };
}

/**
 * Locate the existing managed segment in a file's content. Returns the
 * full segment string (markers included) and its [start, end) byte offsets,
 * or null if no markers are present.
 */
export function findManagedSegment(content: string): {
  segment: string;
  start: number;
  end: number;
} | null {
  const beginIdx = content.indexOf(BEGIN_MARKER);
  if (beginIdx < 0) return null;
  const endIdx = content.indexOf(END_MARKER, beginIdx);
  if (endIdx < 0) return null;
  const tail = endIdx + END_MARKER.length;
  return { segment: content.slice(beginIdx, tail), start: beginIdx, end: tail };
}

/**
 * Splice a freshly generated segment into the file. Behaviour:
 *   - if existing markers found: replace what's between them (inclusive)
 *   - else if file empty: just emit the segment + trailing CRLF
 *   - else: prepend a new segment + blank line + the existing content,
 *           preserving outside-marker content untouched.
 *
 * CRLF preservation: the function does NOT touch line endings outside the
 * segment. The segment itself is always emitted with \r\n separators
 * (Squad runs on Windows-style endings even on Linux).
 */
export function spliceManagedSegment(originalContent: string, newSegmentBody: string): string {
  const located = findManagedSegment(originalContent);
  if (located) {
    return (
      originalContent.slice(0, located.start) + newSegmentBody + originalContent.slice(located.end)
    );
  }
  if (originalContent.length === 0) {
    return `${newSegmentBody}${SEGMENT_NEWLINE}`;
  }
  return `${newSegmentBody}${SEGMENT_NEWLINE}${SEGMENT_NEWLINE}${originalContent}`;
}
