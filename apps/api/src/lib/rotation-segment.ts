/**
 * ROT-2 (#145): managed-segment mechanics for `LayerRotation.cfg`.
 *
 * The generic marker handling (`findManagedSegment`/`spliceManagedSegment`,
 * marker strings, CRLF joining) is shared with the SYNC-3 `Admins.cfg` writer
 * through `@squad/shared-config/admins-config`, so both files round-trip the
 * same managed segment. This module adds only the rotation-specific parsing,
 * building and validation, and re-exports the shared helpers for its callers.
 */

import {
  BEGIN_MARKER,
  END_MARKER,
  findManagedSegment,
  spliceManagedSegment,
} from '@squad/shared-config/admins-config';

export { BEGIN_MARKER, END_MARKER, findManagedSegment, spliceManagedSegment };

const BEGIN_LINE = `${BEGIN_MARKER} — не редактировать вручную`;
const SEGMENT_NEWLINE = '\r\n';

/** Upper bound enforced by {@link validateLayerName}. */
const MAX_LAYER_NAME_LENGTH = 128;

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
