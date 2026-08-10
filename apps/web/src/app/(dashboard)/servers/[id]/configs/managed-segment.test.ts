import { describe, expect, it } from 'vitest';
import { managedSegmentLineRange, managedSegmentText } from './managed-segment';

const BEGIN = '//SQUAD-PANEL BEGIN — не редактировать вручную';
const END = '//SQUAD-PANEL END';

function crlf(lines: string[]): string {
  return lines.join('\r\n');
}
function lf(lines: string[]): string {
  return lines.join('\n');
}

describe('managedSegmentLineRange', () => {
  it('returns 1-based inclusive line numbers for a CRLF segment mid-file', () => {
    const content = crlf(['// operator header', BEGIN, 'Group=Admin:foo', 'Admin=1:Admin', END]);
    expect(managedSegmentLineRange(content)).toEqual({ startLine: 2, endLine: 5 });
  });

  it('handles a segment that starts on line 1', () => {
    const content = crlf([BEGIN, 'Group=Admin:foo', END, '', '// trailing operator note']);
    expect(managedSegmentLineRange(content)).toEqual({ startLine: 1, endLine: 3 });
  });

  it('handles a segment that ends at EOF with no trailing newline', () => {
    const content = crlf(['// header', '', BEGIN, END]);
    expect(managedSegmentLineRange(content)).toEqual({ startLine: 3, endLine: 4 });
  });

  it('works for LF-only content', () => {
    const content = lf(['a', 'b', BEGIN, 'Group=Admin:foo', END]);
    expect(managedSegmentLineRange(content)).toEqual({ startLine: 3, endLine: 5 });
  });

  it('returns null when BEGIN is present without END', () => {
    const content = crlf(['// header', BEGIN, 'Group=Admin:foo']);
    expect(managedSegmentLineRange(content)).toBeNull();
  });

  it('returns null when no markers are present', () => {
    const content = crlf(['[SquadName]', 'Name=Test Server']);
    expect(managedSegmentLineRange(content)).toBeNull();
  });
});

describe('managedSegmentText', () => {
  it('returns the full segment (markers included) for CRLF content', () => {
    const content = crlf(['// header', BEGIN, 'Group=Admin:foo', END, '// tail']);
    expect(managedSegmentText(content)).toBe(crlf([BEGIN, 'Group=Admin:foo', END]));
  });

  it('returns null when no complete marker pair is present', () => {
    expect(managedSegmentText(crlf(['// header', BEGIN]))).toBeNull();
    expect(managedSegmentText('plain content')).toBeNull();
  });
});
