import { describe, expect, it } from 'vitest';
import { DIAG_STREAM_KEY, DIAG_STREAM_MAXLEN } from '../src/diag.js';

describe('diag stream constants', () => {
  it('exposes the panel-wide diagnostic stream key', () => {
    expect(DIAG_STREAM_KEY).toBe('diag:queue');
  });

  it('caps stream length at 100 000 entries (~30 MiB safety net)', () => {
    expect(DIAG_STREAM_MAXLEN).toBe(100_000);
  });
});
