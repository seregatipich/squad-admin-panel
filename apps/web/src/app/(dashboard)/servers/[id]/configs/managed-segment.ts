import { findManagedSegment } from '@squad/shared-config/admins-config';

/**
 * The `//SQUAD-PANEL BEGIN … //SQUAD-PANEL END` block Admins.cfg carries is
 * owned by the config-sync worker; the CFG-1 editor must present it as
 * read-only. Monaco addresses text by 1-based line numbers, but
 * {@link findManagedSegment} reports character offsets, so these helpers bridge
 * the two representations for the editor's decorations + undo-guard.
 */

/** Number of `\n` characters in `s` (CRLF counts as one, matching Monaco lines). */
function countNewlines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 10) n++;
  }
  return n;
}

/**
 * The 1-based inclusive Monaco line range spanned by the managed segment, or
 * `null` when the content has no complete `BEGIN … END` marker pair. Works for
 * both CRLF and LF content because only `\n` occurrences are counted.
 */
export function managedSegmentLineRange(content: string): {
  startLine: number;
  endLine: number;
} | null {
  const located = findManagedSegment(content);
  if (!located) return null;
  const startLine = 1 + countNewlines(content.slice(0, located.start));
  const endLine = startLine + countNewlines(located.segment);
  return { startLine, endLine };
}

/**
 * The exact managed-segment text (markers included), or `null` when the content
 * has no complete `BEGIN … END` marker pair.
 */
export function managedSegmentText(content: string): string | null {
  return findManagedSegment(content)?.segment ?? null;
}
