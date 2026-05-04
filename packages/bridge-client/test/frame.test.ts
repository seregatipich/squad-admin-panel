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
    // BRIDGE_MAX_FRAME_BYTES is 16 MiB; 17 MiB guarantees overflow.
    const big = 'x'.repeat(17 * 1024 * 1024);
    expect(() => encodeFrame({ big })).toThrow(FrameTooLargeError);
  });

  it('rejects oversized decode (declared size exceeds max)', () => {
    const buf = Buffer.alloc(4);
    buf.writeUInt32BE(17 * 1024 * 1024, 0);
    expect(() => decodeFrames(buf)).toThrow(FrameTooLargeError);
  });

  it('returns no frames when fewer than 4 bytes are available', () => {
    const { frames, remainder } = decodeFrames(Buffer.from([0x01, 0x02]));
    expect(frames).toHaveLength(0);
    expect(remainder.byteLength).toBe(2);
  });

  it('decodes a frame followed by a partial header (returns 1 frame, remainder = partial)', () => {
    const a = encodeFrame({ a: 1 });
    const partial = Buffer.from([0x00, 0x00]);
    const { frames, remainder } = decodeFrames(Buffer.concat([a, partial]));
    expect(frames).toHaveLength(1);
    expect(remainder.equals(partial)).toBe(true);
  });

  it('decodes an empty payload (size = 0)', () => {
    const buf = Buffer.alloc(4);
    buf.writeUInt32BE(0, 0);
    const { frames, remainder } = decodeFrames(buf);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.byteLength).toBe(0);
    expect(remainder.byteLength).toBe(0);
  });
});
