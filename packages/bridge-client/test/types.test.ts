import { describe, expect, it } from 'vitest';
import { FrameTooLargeError } from '../src/frame.js';
import { BridgeError } from '../src/types.js';

describe('BridgeError', () => {
  it('preserves code, message, and detail', () => {
    const err = new BridgeError('forbidden', 'path not allowed', { path: '/etc/passwd' });
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('forbidden');
    expect(err.message).toBe('path not allowed');
    expect(err.detail).toEqual({ path: '/etc/passwd' });
    expect(err.name).toBe('BridgeError');
  });

  it('omits detail when not provided', () => {
    const err = new BridgeError('timeout', 'too slow');
    expect(err.detail).toBeUndefined();
  });
});

describe('FrameTooLargeError', () => {
  it('exposes a stable error code and the offending size in the message', () => {
    const err = new FrameTooLargeError(99_999_999);
    expect(err.code).toBe('frame_too_large');
    expect(err.message).toContain('99999999');
    expect(err).toBeInstanceOf(Error);
  });
});
