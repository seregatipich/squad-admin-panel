import { describe, expect, it } from 'vitest';
import { decodeFrames, encodeFrame, FrameTooLargeError } from '../src/frame.js';

describe('frame codec', () => {
  it('encodes and decodes a single envelope', () => {
    const payload = { id: '1', method: 'ping' };
    const frame = encodeFrame(payload);
    const { frames, remainder } = decodeFrames(frame);
    expect(frames).toHaveLength(1);
    expect(remainder.byteLength).toBe(0);
    const first = frames[0];
    expect(first).toBeDefined();
    if (first) expect(JSON.parse(first.toString('utf-8'))).toEqual(payload);
  });

  it('decodes two concatenated frames', () => {
    const a = encodeFrame({ a: 1 });
    const b = encodeFrame({ b: 2 });
    const { frames, remainder } = decodeFrames(Buffer.concat([a, b]));
    expect(frames).toHaveLength(2);
    expect(remainder.byteLength).toBe(0);
  });

  it('leaves a partial frame in the remainder', () => {
    const full = encodeFrame({ hello: 'world' });
    const truncated = full.subarray(0, full.byteLength - 3);
    const { frames, remainder } = decodeFrames(truncated);
    expect(frames).toHaveLength(0);
    expect(remainder.byteLength).toBe(truncated.byteLength);
  });

  it('rejects oversized encode', () => {
    const big = 'x'.repeat(2 * 1024 * 1024);
    expect(() => encodeFrame({ big })).toThrow(FrameTooLargeError);
  });
});
