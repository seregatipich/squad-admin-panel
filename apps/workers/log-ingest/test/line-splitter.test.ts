import { describe, expect, it, vi } from 'vitest';
import { createLineSplitter, MAX_PENDING_LINE_CHARS } from '../src/line-splitter.js';

describe('createLineSplitter', () => {
  it('emits complete lines, strips a trailing CR and skips empty lines', () => {
    const onLine = vi.fn();
    const push = createLineSplitter(onLine);
    push('one\r\ntw');
    push('o\n\nthree\n');
    expect(onLine.mock.calls.map((call) => call[0])).toEqual(['one', 'two', 'three']);
  });

  it('drops an unterminated line that outgrows the limit and recovers on the next newline', () => {
    const onLine = vi.fn();
    const onOverflow = vi.fn();
    const push = createLineSplitter(onLine, onOverflow);
    push('x'.repeat(MAX_PENDING_LINE_CHARS + 1));
    push('tail of the oversized line\nnext line\n');
    expect(onOverflow).toHaveBeenCalledOnce();
    expect(onLine.mock.calls.map((call) => call[0])).toEqual(['next line']);
  });
});
