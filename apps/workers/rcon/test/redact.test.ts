import { describe, expect, it } from 'vitest';
import { redactRconLine, redactRconSample } from '../src/redact.js';

describe('RCON sample redaction', () => {
  it('keeps the field layout of a ListPlayers row and masks every identifying value', () => {
    const row =
      'ID: 60 | Online IDs: EOS: abcdef0123456789abcdef0123456789 steam: 76561198012345678 | Name:  -quic | Team ID: 2 | Party ID: N/A | Squad ID: 1 | Is Leader: False | Role: USA_Medic_02 | Vehicle: N/A';
    expect(redactRconLine(row)).toBe(
      'ID: 60 | Online IDs: <str> | Name: <str> | Team ID: 2 | Party ID: N/A | Squad ID: 1 | Is Leader: False | Role: <str> | Vehicle: N/A',
    );
  });

  it('masks a squad row, including the creator', () => {
    const squad =
      'ID: 1 | Name: Squad 1 | Size: 8 | Locked: False | Creator Name: [TAG] Nick | Creator Online IDs: EOS: abcdef0123456789abcdef0123456789 steam: 76561198012345678';
    const out = redactRconLine(squad);
    expect(out).toBe(
      'ID: 1 | Name: <str> | Size: 8 | Locked: False | Creator Name: <str> | Creator Online IDs: <str>',
    );
  });

  it('masks a value under a field name it has never seen', () => {
    const out = redactRconLine('ID: 3 | Owner: Secret Nick | Account: 76561198012345678');
    expect(out).toBe('ID: 3 | Owner: <str> | Account: <str>');
  });

  it('masks a segment that is not a field at all, such as the tail of a name with a pipe', () => {
    expect(redactRconLine('ID: 8 | Name: [TAG] Nick | Alt | Team ID: 1')).toBe(
      'ID: 8 | Name: <str> | <str> | Team ID: 1',
    );
  });

  it('limits a sample to the first lines and caps each line', () => {
    expect(redactRconSample(['a: 1', 'b: 2', 'c: 3'])).toEqual(['a: 1', 'b: 2']);
    expect(redactRconLine(`ID: 1 | ${'k'.repeat(30)}: 2`.repeat(40)).length).toBeLessThanOrEqual(
      400,
    );
  });
});
