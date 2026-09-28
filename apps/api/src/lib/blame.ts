import { diffArrays } from 'diff';

export interface BlameVersion {
  id: string;
  content: string;
  author_player_id: string | null;
  author_label: string | null;
  created_at: string;
}

export interface BlameLine {
  text: string;
  version_id: string;
  author_player_id: string | null;
  created_at: string;
}

/**
 * Walk the version chain from oldest to newest. For each version we
 * compute the line-level diff against its predecessor and carry forward
 * the attribution for unchanged lines; changed / inserted lines get
 * assigned to the current version's author. The final blame array has
 * one entry per line in the tip version.
 *
 * Deleted lines fall off naturally (they aren't present in the next
 * version's array). We use the `diff` library's Myers-based `diffArrays`
 * on per-line arrays so whitespace / newline handling is explicit.
 *
 * Myers runs synchronously in O((N+M)·D), so two large unrelated versions
 * would block the event loop for minutes (#283). All pairwise diffs share one
 * `timeoutMs` budget; when it runs out the walk is abandoned.
 *
 * @param versions - The versions to attribute, in any order.
 * @param opts.timeoutMs - Wall-clock budget for every diff together.
 * @returns One entry per tip line, or `undefined` when the budget ran out.
 */
export function computeBlame(
  versions: BlameVersion[],
  opts: { timeoutMs: number },
): BlameLine[] | undefined {
  if (versions.length === 0) return [];
  const deadline = Date.now() + opts.timeoutMs;

  const sorted = [...versions].sort((a, b) =>
    a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0,
  );

  // Initial version: every line attributed to it. sorted[0] is defined
  // because we returned early on empty input; the non-null assertion
  // is safe here.
  const first = sorted[0] as BlameVersion;
  let current: BlameLine[] = splitLines(first.content).map((text) => ({
    text,
    version_id: first.id,
    author_player_id: first.author_player_id,
    created_at: first.created_at,
  }));

  for (let i = 1; i < sorted.length; i++) {
    // i < sorted.length by the loop condition, so this index is always in bounds.
    const v = sorted[i] as BlameVersion;
    const prev = current.map((l) => l.text);
    const next = splitLines(v.content);
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return undefined;
    const parts = diffArrays(prev, next, { timeout: remainingMs });
    if (!parts) return undefined;
    const out: BlameLine[] = [];
    let prevCursor = 0;
    for (const part of parts) {
      if (part.added) {
        for (const text of part.value) {
          out.push({
            text,
            version_id: v.id,
            author_player_id: v.author_player_id,
            created_at: v.created_at,
          });
        }
      } else if (part.removed) {
        prevCursor += part.value.length;
      } else {
        // An unchanged part's value is a contiguous slice of `prev`, which was
        // built 1:1 from `current`, so every prevCursor + k here is in bounds.
        for (let k = 0; k < part.value.length; k++) {
          out.push(current[prevCursor + k] as BlameLine);
        }
        prevCursor += part.value.length;
      }
    }
    current = out;
  }
  return current;
}

function splitLines(s: string): string[] {
  // Preserve empty trailing line for predictable diffing round-trips.
  const parts = s.split(/\r?\n/);
  return parts;
}
