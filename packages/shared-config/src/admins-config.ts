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
 * Characters that end a line in Admins.cfg or in an editor: every Unicode
 * control character (C0, DEL, C1 — which covers CR, LF, TAB and NEL) plus the
 * Unicode line and paragraph separators U+2028/U+2029.
 */
const LINE_BREAKING_CHARACTERS = /[\p{Cc}\u2028\u2029]/u;
const LINE_BREAKING_RUNS = /[\p{Cc}\u2028\u2029]+/gu;
/**
 * Squad parses `Group=<name>:<perm>,<perm>` and `Admin=<id>:<name>`, and `//`
 * starts a comment (and both managed-segment markers), so a group name must
 * not contain `:`, `,` or `/`.
 */
const ROLE_NAME_SYNTAX_CHARACTERS = /[:,/]/;
const SLASH_RUNS = /\/{2,}/g;

/**
 * Whether a panel role name can be written verbatim as an Admins.cfg group
 * name (`Group=<name>:…`, `Admin=<id>:<name>`) without changing the file's
 * structure. Letters of any script, digits, spaces, `-` and `_` are fine; a
 * blank name, any control or line-separator character, `:`, `,` and `/` are
 * not (issue #11).
 *
 * @param name - The role name as stored in `roles.name`.
 * @returns `true` when the name is safe to emit into the managed segment.
 */
export function isAdminsCfgSafeRoleName(name: string): boolean {
  return (
    name.trim().length > 0 &&
    !LINE_BREAKING_CHARACTERS.test(name) &&
    !ROLE_NAME_SYNTAX_CHARACTERS.test(name)
  );
}

/**
 * Whether free text (an assignment comment, a clan name) stays on one line
 * when written into Admins.cfg: it contains no control character and no
 * Unicode line/paragraph separator. Used by the API to reject such input up
 * front; the generator additionally flattens it (see `buildManagedSegmentBody`).
 *
 * @param text - The user-supplied text.
 * @returns `true` when the text contains no line-breaking character.
 */
export function isAdminsCfgSingleLineText(text: string): boolean {
  return !LINE_BREAKING_CHARACTERS.test(text);
}

/**
 * Make free text safe for the trailing `// …` comment of an Admin= line:
 * every run of line-breaking characters becomes one space, and every run of
 * slashes collapses to one so neither `//SQUAD-PANEL BEGIN` nor
 * `//SQUAD-PANEL END` can appear inside the segment and cut it short on the
 * next sync.
 */
function toAdminsCfgCommentText(text: string): string {
  return text.replace(LINE_BREAKING_RUNS, ' ').replace(SLASH_RUNS, '/').trim();
}

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
 * Every value is written so the segment keeps its line structure (issue #11):
 * a role whose name fails `isAdminsCfgSafeRoleName` is left out together
 * with all of its Admin= lines, and comments and clan names are flattened to
 * one line with no `//` sequence. This holds for rows written by any path,
 * including ones older than the API-side validation.
 *
 * `clanPriority` (CLAN-4) is appended after the role-derived groups/admins:
 * a constant `Group=ClanPriority:reserve` line (skipped if a real role is
 * already named `ClanPriority`, to avoid a duplicate Group= definition),
 * followed by one `Admin=<eosId>:ClanPriority // clan:<name>` line per
 * entry, sorted by eos_id.
 */
export function buildManagedSegmentBody(inputs: SegmentInputs): ManagedSegmentBody {
  const rolesWithPerms = inputs.roles
    .filter((r) => r.squadPermissions.length > 0 && isAdminsCfgSafeRoleName(r.name))
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
    const comment = admin.comment ? toAdminsCfgCommentText(admin.comment) : '';
    lines.push(comment ? `${base} // ${comment}` : base);
  }
  for (const entry of clanAdmins) {
    const clanName = toAdminsCfgCommentText(entry.clanName);
    lines.push(`Admin=${entry.eosId}:${CLAN_PRIORITY_GROUP_NAME} // clan:${clanName}`);
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
 * or null if no begin marker is present.
 *
 * A begin marker with no matching end marker is a corrupt/orphaned segment
 * (e.g. from a write interrupted mid-flight): the "segment" is taken to run
 * to the end of the file so the next splice replaces it wholesale, rather
 * than leaving the orphaned `Admin=`/`Group=` lines behind forever while a
 * fresh segment is prepended in front of them.
 */
export function findManagedSegment(content: string): {
  segment: string;
  start: number;
  end: number;
} | null {
  const beginIdx = content.indexOf(BEGIN_MARKER);
  if (beginIdx < 0) return null;
  const endIdx = content.indexOf(END_MARKER, beginIdx);
  const tail = endIdx < 0 ? content.length : endIdx + END_MARKER.length;
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
