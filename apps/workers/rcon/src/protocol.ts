/**
 * Valve Source RCON protocol encoder/decoder.
 *
 * Wire format per packet:
 *   int32 size   (little-endian, bytes after this field)
 *   int32 id     (echoed back)
 *   int32 type   (SERVERDATA_AUTH=3, SERVERDATA_EXECCOMMAND=2,
 *                 SERVERDATA_RESPONSE_VALUE=0, SERVERDATA_AUTH_RESPONSE=2)
 *   ASCII body   (null-terminated)
 *   0x00         (trailing null)
 *
 * Behaviour quirks observed against Squad v10.3.1 (§0A.4):
 *   - AUTH returns two packets: an empty SERVERDATA_RESPONSE_VALUE followed
 *     by SERVERDATA_AUTH_RESPONSE with the same id as the request.
 *   - Multi-packet responses are delimited with the "empty ping" trick:
 *     after the real EXECCOMMAND, the client sends a second EXECCOMMAND
 *     with id=`probeId` and empty body; when the probe's response
 *     arrives, all chunks for the real command have been delivered.
 *   - Squad answers that empty probe TWICE. The first reply is a regular
 *     empty SERVERDATA_RESPONSE_VALUE; the second claims size 10 but is
 *     actually 17 bytes long (21 with the size header) — its body is
 *     `00 00 00 01 00 00 00`. Captured verbatim from a live v8 server on
 *     2026-09-07 and handled the same way SquadJS's core/rcon.js does.
 *     Left in the stream, those 7 trailing bytes parse as a size-256 header
 *     and every later response is mis-framed (`invalid RCON packet size`
 *     errors, exec timeouts, a reconnect loop).
 */

export const SERVERDATA_AUTH = 3;
export const SERVERDATA_EXECCOMMAND = 2;
export const SERVERDATA_AUTH_RESPONSE = 2;
export const SERVERDATA_RESPONSE_VALUE = 0;

export interface RconPacket {
  id: number;
  type: number;
  body: string;
}

export function encodePacket(packet: RconPacket): Buffer {
  const body = Buffer.from(packet.body, 'utf-8');
  const payload = Buffer.alloc(4 + 4 + body.byteLength + 2);
  payload.writeInt32LE(packet.id, 0);
  payload.writeInt32LE(packet.type, 4);
  body.copy(payload, 8);
  // trailing \0\0
  payload[8 + body.byteLength] = 0;
  payload[9 + body.byteLength] = 0;
  const header = Buffer.alloc(4);
  header.writeInt32LE(payload.byteLength, 0);
  return Buffer.concat([header, payload]);
}

/**
 * Body of Squad's second answer to the empty probe (see the header comment):
 * the 7 bytes that follow the two null terminators of a size-10 frame.
 */
export const SQUAD_BROKEN_PROBE_TAIL = Buffer.from([0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00]);
const BROKEN_PROBE_FRAME_LENGTH = 21;

export class RconPacketStream {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): RconPacket[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out: RconPacket[] = [];
    while (this.buf.byteLength >= 4) {
      // The broken probe reply's 7 trailing bytes may sit at the head of the
      // buffer on their own when the TCP chunking split the 21-byte frame
      // after its first 14 bytes. A genuine frame can never start with them:
      // that would be size 256 with a packet id below 256, and every id this
      // client issues is >= 1000.
      if (this.startsWithBrokenProbeTail()) {
        this.buf = this.buf.subarray(SQUAD_BROKEN_PROBE_TAIL.byteLength);
        continue;
      }
      if (this.isBrokenProbeTailPrefix()) break;
      const size = this.buf.readInt32LE(0);
      if (size < 10) {
        throw new Error(`invalid RCON packet size: ${size}`);
      }
      // The whole 21-byte broken frame in one go: a size-10 empty packet
      // immediately followed by the 7-byte tail. Drop it entirely; the
      // legitimate probe echo was the size-10 frame before it.
      if (
        size === 10 &&
        this.buf.byteLength >= BROKEN_PROBE_FRAME_LENGTH &&
        this.buf.subarray(14, BROKEN_PROBE_FRAME_LENGTH).equals(SQUAD_BROKEN_PROBE_TAIL)
      ) {
        this.buf = this.buf.subarray(BROKEN_PROBE_FRAME_LENGTH);
        continue;
      }
      if (this.buf.byteLength - 4 < size) break;
      const id = this.buf.readInt32LE(4);
      const type = this.buf.readInt32LE(8);
      const bodyEnd = 4 + size - 2; // last two bytes are null terminators
      const body = this.buf.subarray(12, bodyEnd).toString('utf-8');
      out.push({ id, type, body });
      this.buf = this.buf.subarray(4 + size);
    }
    return out;
  }

  private startsWithBrokenProbeTail(): boolean {
    return (
      this.buf.byteLength >= SQUAD_BROKEN_PROBE_TAIL.byteLength &&
      this.buf.subarray(0, SQUAD_BROKEN_PROBE_TAIL.byteLength).equals(SQUAD_BROKEN_PROBE_TAIL)
    );
  }

  /** A strict prefix of the tail: wait for the rest instead of mis-reading a size. */
  private isBrokenProbeTailPrefix(): boolean {
    const n = this.buf.byteLength;
    return (
      n < SQUAD_BROKEN_PROBE_TAIL.byteLength &&
      this.buf.equals(SQUAD_BROKEN_PROBE_TAIL.subarray(0, n))
    );
  }
}
