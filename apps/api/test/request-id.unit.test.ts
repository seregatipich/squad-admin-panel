import { describe, expect, it } from 'vitest';
import { resolveRequestId } from '../src/lib/request-id.js';

// Regression tests for findings #379 and #1309: genReqId used to trust the
// client-supplied X-Request-Id header outright, so an anonymous caller
// (including through public routes) could write an arbitrary string up to
// ~16 KiB, or a colliding/forged id, into the immutable audit_log hash
// chain, and the value never matched request-context.ts's own generated id.
describe('resolveRequestId', () => {
  it('reuses a header that matches the accepted request-id shape', () => {
    expect(resolveRequestId('client-supplied-id_123')).toBe('client-supplied-id_123');
  });

  it('generates a fresh id when no header is supplied', () => {
    const id = resolveRequestId(undefined);
    expect(id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('rejects a header containing characters outside [\\w-]', () => {
    const id = resolveRequestId('bad id; DROP TABLE audit_log');
    expect(id).not.toBe('bad id; DROP TABLE audit_log');
    expect(id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('never returns an id longer than the 128-char cap, even for a ~16 KiB header', () => {
    const huge = 'a'.repeat(16_000);
    const id = resolveRequestId(huge);
    expect(id.length).toBeLessThanOrEqual(128);
  });

  it('returns a distinct id each time no header is supplied', () => {
    expect(resolveRequestId(undefined)).not.toBe(resolveRequestId(undefined));
  });
});
