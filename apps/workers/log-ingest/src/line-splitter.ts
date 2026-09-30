/** Longest unterminated line kept in memory before the remainder is discarded. */
export const MAX_PENDING_LINE_CHARS = 64 * 1024;

/**
 * Builds a chunk-to-line splitter shared by the container and SSH log tails.
 * Lines are split on `\n`, a trailing `\r` is stripped and empty lines are
 * skipped. A line that stays unterminated beyond {@link MAX_PENDING_LINE_CHARS}
 * (binary or corrupted output) is dropped up to its next newline instead of
 * growing the buffer without bound.
 *
 * @param onLine Called once per complete, non-empty line.
 * @param onOverflow Called when an oversized unterminated line is discarded.
 * @returns A function that accepts the next decoded text chunk.
 */
export function createLineSplitter(
  onLine: (line: string) => void,
  onOverflow?: () => void,
): (chunk: string) => void {
  let pending = '';
  let discardingUntilNewline = false;

  return (chunk) => {
    const parts = chunk.split('\n');
    const unterminated = parts.pop() ?? '';

    parts.forEach((part, index) => {
      const text = index === 0 ? pending + part : part;
      const skipped = index === 0 && discardingUntilNewline;
      pending = '';
      discardingUntilNewline = false;
      const line = text.endsWith('\r') ? text.slice(0, -1) : text;
      if (skipped || line.length === 0) return;
      onLine(line);
    });

    const carried = parts.length === 0 ? pending + unterminated : unterminated;
    if (discardingUntilNewline || carried.length > MAX_PENDING_LINE_CHARS) {
      if (!discardingUntilNewline) onOverflow?.();
      discardingUntilNewline = true;
      pending = '';
      return;
    }
    pending = carried;
  };
}
