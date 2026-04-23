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
