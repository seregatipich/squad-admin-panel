import { createHash } from 'node:crypto';

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

export interface SegmentInputs {
  roles: RoleEntry[];
  admins: AdminEntry[];
}

export interface ManagedSegment {
  body: string;
  hash: string;
  groupsCount: number;
  adminsCount: number;
}

/**
 * Build the body of the //SQUAD-PANEL BEGIN/END managed segment from a
 * snapshot of the DB. Only roles with at least one Squad permission emit
 * a Group= line. Only admin entries whose role has at least one Squad
 * permission emit an Admin= line. The order is deterministic (sorted
 * alphabetically by role name then by eos_id) so the
 * sha256 idempotency check is stable.
 */
export function buildManagedSegment(inputs: SegmentInputs): ManagedSegment {
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

  const lines: string[] = [BEGIN_LINE];
  for (const role of rolesWithPerms) {
    lines.push(`Group=${role.name}:${role.squadPermissions.join(',')}`);
  }
  if (rolesWithPerms.length > 0 && admins.length > 0) lines.push('');
  for (const admin of admins) {
    const base = `Admin=${admin.eosId}:${admin.roleName}`;
    lines.push(admin.comment ? `${base} // ${admin.comment}` : base);
  }
  lines.push(END_MARKER);

  const body = lines.join(SEGMENT_NEWLINE);
  const hash = createHash('sha256').update(body, 'utf8').digest('hex');
  return {
    body,
    hash,
    groupsCount: rolesWithPerms.length,
    adminsCount: admins.length,
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

export function hashSegment(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}
