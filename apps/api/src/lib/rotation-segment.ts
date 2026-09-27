/**
 * ROT-2 (#145): pure managed-segment mechanics for `LayerRotation.cfg`.
 *
 * This module intentionally re-implements the generic
 * `findManagedSegment`/`spliceManagedSegment` functions from
 * `apps/workers/config-sync/src/segment.ts` byte-for-byte (marker strings and
 * CRLF joining included). Worker packages are not importable from the API, so
 * the two copies must be kept in sync manually — if the marker strings or the
 * splice semantics ever change here, mirror the change in
 * `apps/workers/config-sync/src/segment.ts` (and vice versa), otherwise the
 * managed segment stops round-tripping between SYNC-3 (Admins.cfg) and this
 * rotation editor.
 */

export const BEGIN_MARKER = '//SQUAD-PANEL BEGIN';
export const END_MARKER = '//SQUAD-PANEL END';
const BEGIN_LINE = `${BEGIN_MARKER} — не редактировать вручную`;
const SEGMENT_NEWLINE = '\r\n';

/** Upper bound enforced by {@link validateLayerName}. */
const MAX_LAYER_NAME_LENGTH = 128;

export interface LocatedSegment {
  segment: string;
  start: number;
  end: number;
}

/**
 * Locate the existing managed segment in a file's content. Returns the full
 * segment string (markers included) and its [start, end) byte offsets, or
 * null if no markers are present.
 */
export function findManagedSegment(content: string): LocatedSegment | null {
  const beginIdx = content.indexOf(BEGIN_MARKER);
  if (beginIdx < 0) return null;
  const endIdx = content.indexOf(END_MARKER, beginIdx);
  if (endIdx < 0) return null;
  const tail = endIdx + END_MARKER.length;
  return { segment: content.slice(beginIdx, tail), start: beginIdx, end: tail };
}

/**
 * Splice a freshly generated segment body into the file. Behaviour:
 *   - if existing markers found: replace what's between them (inclusive)
 *   - else if file empty: just emit the segment + trailing CRLF
 *   - else: prepend a new segment + blank line + the existing content,
 *           preserving outside-marker content untouched.
 *
 * CRLF preservation: the function does NOT touch line endings outside the
 * segment. The segment itself is always emitted with \r\n separators (Squad
 * runs on Windows-style endings even on Linux).
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

export interface ParsedRotationSegment {
  layers: string[];
}

/**
 * Parses the layer names out of the managed segment of a `LayerRotation.cfg`
 * file's full content. Lines are trimmed; blank lines and lines starting
 * with `//` (operator comments) are skipped. Returns `{ layers: [] }` when
 * the file has no managed segment yet.
 */
export function parseRotationSegment(content: string): ParsedRotationSegment {
  const located = findManagedSegment(content);
  if (!located) return { layers: [] };
  // The segment's first and last lines are the BEGIN/END marker lines
  // themselves; everything in between is layer names.
  const lines = located.segment.split(/\r\n|\n/).slice(1, -1);
  const names = lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('//'));
  return { layers: names };
}

/**
 * Builds the managed-segment body (markers included, one layer name per
 * line, CRLF-joined) from an ordered list of layer names. Pass the result to
 * {@link spliceManagedSegment} to write it back into the file.
 */
export function buildRotationSegmentBody(layerNames: readonly string[]): string {
  return [BEGIN_LINE, ...layerNames, END_MARKER].join(SEGMENT_NEWLINE);
}

/**
 * Sanity-checks a single layer name before it is allowed into the managed
 * segment, so every accepted name round-trips through
 * {@link buildRotationSegmentBody} → {@link parseRotationSegment} unchanged:
 *   - 1–128 characters;
 *   - no control characters (CR/LF would split the line, the rest are never
 *     part of a Squad layer name);
 *   - no leading/trailing whitespace, which the parser trims;
 *   - no `//` anywhere — a leading one would be read back as an operator
 *     comment, and one mid-name can carry {@link BEGIN_MARKER} or
 *     {@link END_MARKER}, which {@link findManagedSegment} would match inside
 *     the name and so truncate the segment (#36).
 */
export function validateLayerName(name: string): boolean {
  if (name.length < 1 || name.length > MAX_LAYER_NAME_LENGTH) return false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
  if (/[\u0000-\u001f\u007f]/.test(name)) return false;
  if (name.trim() !== name) return false;
  if (name.includes('//')) return false;
  return true;
}
