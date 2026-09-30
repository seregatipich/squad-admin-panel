import { describe, expect, it } from 'vitest';
import { managedSegmentLineRange } from './managed-segment';

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

  it('extends an orphaned BEGIN to the end of the file, as the config-sync splice replaces it', () => {
    const content = crlf(['// header', BEGIN, 'Group=Admin:foo']);
    expect(managedSegmentLineRange(content)).toEqual({ startLine: 2, endLine: 3 });
  });

  it('returns null when no markers are present', () => {
    const content = crlf(['[SquadName]', 'Name=Test Server']);
    expect(managedSegmentLineRange(content)).toBeNull();
  });
});
