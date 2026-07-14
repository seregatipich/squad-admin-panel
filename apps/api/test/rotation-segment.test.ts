import { describe, expect, it } from 'vitest';
import {
  BEGIN_MARKER,
  buildRotationSegmentBody,
  END_MARKER,
  findManagedSegment,
  parseRotationSegment,
  spliceManagedSegment,
  validateLayerName,
} from '../src/lib/rotation-segment.js';

describe('parseRotationSegment', () => {
  it('extracts layer names in order from the managed segment', () => {
    const content = [
      '// operator comment above',
      `${BEGIN_MARKER} — не редактировать вручную`,
      'Yehorivka RAAS v11',
      'Gorodok RAAS v1',
      END_MARKER,
      'ManuallyAddedLine',
    ].join('\r\n');
    expect(parseRotationSegment(content).layers).toEqual(['Yehorivka RAAS v11', 'Gorodok RAAS v1']);
  });

  it('skips blank and // comment lines inside the segment', () => {
    const content = [
      `${BEGIN_MARKER} — не редактировать вручную`,
      'Yehorivka RAAS v11',
      '',
      '// this is a note, not a layer',
      'Gorodok RAAS v1',
      END_MARKER,
    ].join('\r\n');
    expect(parseRotationSegment(content).layers).toEqual(['Yehorivka RAAS v11', 'Gorodok RAAS v1']);
  });

  it('returns [] when there are no markers', () => {
    expect(parseRotationSegment('just some file content\r\n').layers).toEqual([]);
  });
});

describe('buildRotationSegmentBody', () => {
  it('emits BEGIN line, one layer per line, END marker, CRLF-joined', () => {
    const body = buildRotationSegmentBody(['Yehorivka RAAS v11', 'Gorodok RAAS v1']);
    expect(body).toBe(
      [
        `${BEGIN_MARKER} — не редактировать вручную`,
        'Yehorivka RAAS v11',
        'Gorodok RAAS v1',
        END_MARKER,
      ].join('\r\n'),
    );
  });

  it('emits just the markers for an empty layer list', () => {
    const body = buildRotationSegmentBody([]);
    expect(body).toBe([`${BEGIN_MARKER} — не редактировать вручную`, END_MARKER].join('\r\n'));
  });
});

describe('spliceManagedSegment', () => {
  it('replaces only between the markers, preserving surrounding content and its line endings', () => {
    const header = '// header comment, keep me\nManuallyAddedLine\n';
    const trailer = 'TrailerLine\n';
    const oldBody = buildRotationSegmentBody(['OldLayer']);
    const original = `${header}${oldBody}\r\n${trailer}`;
    const newBody = buildRotationSegmentBody(['NewLayer']);
    const result = spliceManagedSegment(original, newBody);
    expect(result.startsWith(header)).toBe(true);
    expect(result.endsWith(trailer)).toBe(true);
    expect(result).toContain(newBody);
    expect(result).not.toContain('OldLayer');
  });

  it('splices into an empty file by emitting the segment plus a trailing CRLF', () => {
    const newBody = buildRotationSegmentBody(['Layer A']);
    expect(spliceManagedSegment('', newBody)).toBe(`${newBody}\r\n`);
  });

  it('prepends the segment to marker-less non-empty content, leaving it untouched', () => {
    const original = 'ExistingLine1\nExistingLine2\n';
    const newBody = buildRotationSegmentBody(['Layer A']);
    const result = spliceManagedSegment(original, newBody);
    expect(result).toBe(`${newBody}\r\n\r\n${original}`);
  });
});

describe('validateLayerName', () => {
  it('accepts a normal layer name', () => {
    expect(validateLayerName('Yehorivka RAAS v11')).toBe(true);
  });

  it('rejects empty names', () => {
    expect(validateLayerName('')).toBe(false);
  });

  it('rejects names over 128 characters', () => {
    expect(validateLayerName('x'.repeat(129))).toBe(false);
  });

  it('rejects names containing CR or LF', () => {
    expect(validateLayerName('a\r\nb')).toBe(false);
    expect(validateLayerName('a\nb')).toBe(false);
  });

  it('rejects names starting with a // comment marker', () => {
    expect(validateLayerName('// not a layer')).toBe(false);
  });
});

describe('round-trip', () => {
  it('parse(splice(original, build(names))) recovers names', () => {
    const names = ['Yehorivka RAAS v11', 'Gorodok RAAS v1', 'Custom_Layer_v9'];
    const body = buildRotationSegmentBody(names);
    const spliced = spliceManagedSegment('', body);
    expect(parseRotationSegment(spliced).layers).toEqual(names);
  });

  it('findManagedSegment locates the exact segment produced by buildRotationSegmentBody', () => {
    const body = buildRotationSegmentBody(['Layer A']);
    const spliced = spliceManagedSegment('prefix\n', body);
    const located = findManagedSegment(spliced);
    expect(located?.segment).toBe(body);
  });
});
