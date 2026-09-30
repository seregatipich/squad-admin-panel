import { BRIDGE_MAX_FRAME_BYTES } from '@squad/shared-config';

export class FrameTooLargeError extends Error {
  readonly code = 'frame_too_large';
  constructor(size: number) {
    super(`bridge frame exceeds max size: ${size} > ${BRIDGE_MAX_FRAME_BYTES}`);
  }
}

export function encodeFrame(payload: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(payload), 'utf-8');
  if (body.byteLength > BRIDGE_MAX_FRAME_BYTES) {
    throw new FrameTooLargeError(body.byteLength);
  }
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.byteLength, 0);
  return Buffer.concat([header, body]);
}

export interface FrameDecoderChunk {
  frames: Buffer[];
  remainder: Buffer;
}

export function decodeFrames(buffer: Buffer): FrameDecoderChunk {
  const frames: Buffer[] = [];
  let offset = 0;
  while (buffer.byteLength - offset >= 4) {
    const size = buffer.readUInt32BE(offset);
    if (size > BRIDGE_MAX_FRAME_BYTES) {
      throw new FrameTooLargeError(size);
    }
    if (buffer.byteLength - offset - 4 < size) {
      break;
    }
    frames.push(buffer.subarray(offset + 4, offset + 4 + size));
    offset += 4 + size;
  }
  return { frames, remainder: buffer.subarray(offset) };
}

/**
 * Incremental decoder for a stream of length-prefixed frames.
 *
 * Received chunks are queued without copying and joined only once the queued
 * bytes cover the next complete frame, whose size is known from its 4-byte
 * header. A frame of N bytes that arrives in k socket chunks therefore costs
 * O(N) copying instead of the O(N·k) of re-concatenating the whole buffer on
 * every chunk. The leftover partial frame is copied out of the joined buffer so
 * it never pins a large, already-consumed allocation in memory.
 */
export class FrameAccumulator {
  private chunks: Buffer[] = [];
  private queuedBytes = 0;

  /**
   * Queues `chunk` and returns every frame body completed by it, in order.
   *
   * @throws {FrameTooLargeError} when a frame header announces a size above
   *   `BRIDGE_MAX_FRAME_BYTES`; the stream is out of sync and must be dropped.
   */
  push(chunk: Buffer): Buffer[] {
    this.chunks.push(chunk);
    this.queuedBytes += chunk.byteLength;
    if (this.queuedBytes < 4) return [];
    const size = this.nextFrameSize();
    if (size > BRIDGE_MAX_FRAME_BYTES) {
      throw new FrameTooLargeError(size);
    }
    if (this.queuedBytes < 4 + size) return [];

    const joined = this.chunks.length === 1 ? chunk : Buffer.concat(this.chunks, this.queuedBytes);
    const { frames, remainder } = decodeFrames(joined);
    this.chunks = remainder.byteLength > 0 ? [Buffer.from(remainder)] : [];
    this.queuedBytes = remainder.byteLength;
    return frames;
  }

  /** Discards every queued byte, e.g. after the socket was dropped. */
  reset(): void {
    this.chunks = [];
    this.queuedBytes = 0;
  }

  private nextFrameSize(): number {
    const head = this.chunks[0] as Buffer;
    const header = head.byteLength >= 4 ? head : Buffer.concat(this.chunks, 4);
    return header.readUInt32BE(0);
  }
}
