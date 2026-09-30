import { BRIDGE_MAX_FRAME_BYTES } from '@squad/shared-config';
import { describe, expect, it } from 'vitest';
import { decodeFrames, encodeFrame, FrameAccumulator, FrameTooLargeError } from '../src/frame.js';

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

describe('FrameAccumulator', () => {
  it('reassembles a frame whose header is split across chunks', () => {
    const frame = encodeFrame({ split: 'header' });
    const acc = new FrameAccumulator();
    expect(acc.push(frame.subarray(0, 2))).toEqual([]);
    expect(acc.push(frame.subarray(2, 3))).toEqual([]);
    const frames = acc.push(frame.subarray(3));
    expect(frames).toHaveLength(1);
    expect(JSON.parse((frames[0] as Buffer).toString('utf-8'))).toEqual({ split: 'header' });
  });

  it('returns every frame completed by one chunk and keeps the partial tail', () => {
    const a = encodeFrame({ a: 1 });
    const b = encodeFrame({ b: 2 });
    const c = encodeFrame({ c: 3 });
    const acc = new FrameAccumulator();
    const stream = Buffer.concat([a, b, c]);
    const cut = a.byteLength + b.byteLength + 5;
    expect(acc.push(stream.subarray(0, cut))).toHaveLength(2);
    const rest = acc.push(stream.subarray(cut));
    expect(rest.map((f) => JSON.parse(f.toString('utf-8')))).toEqual([{ c: 3 }]);
  });

  it('copies the partial tail instead of retaining the consumed buffer', () => {
    const a = encodeFrame({ a: 'x'.repeat(10_000) });
    const b = encodeFrame({ b: 2 });
    const joined = Buffer.concat([a, b.subarray(0, 6)]);
    const acc = new FrameAccumulator();
    expect(acc.push(joined)).toHaveLength(1);
    const tail = (acc as unknown as { chunks: Buffer[] }).chunks[0] as Buffer;
    expect(tail.byteLength).toBe(6);
    expect(tail.buffer).not.toBe(joined.buffer);
  });

  it('throws FrameTooLargeError as soon as an oversized header is seen', () => {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(BRIDGE_MAX_FRAME_BYTES + 1, 0);
    expect(() => new FrameAccumulator().push(header)).toThrow(FrameTooLargeError);
  });

  it('reset() drops queued bytes so the next frame decodes from a clean state', () => {
    const acc = new FrameAccumulator();
    acc.push(encodeFrame({ stale: true }).subarray(0, 7));
    acc.reset();
    const frames = acc.push(encodeFrame({ fresh: true }));
    expect(frames.map((f) => JSON.parse(f.toString('utf-8')))).toEqual([{ fresh: true }]);
  });
});
